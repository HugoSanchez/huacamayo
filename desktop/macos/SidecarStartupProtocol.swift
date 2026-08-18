import Foundation

struct SidecarStartupFailure: Equatable {
    let code: String
    let message: String
    let recoverable: Bool
    let details: String?
}

enum SidecarStartupEvent: Equatable {
    case ready(port: Int)
    case failure(SidecarStartupFailure)
}

/// Incrementally decodes the newline-delimited startup protocol emitted by
/// the orchestrator. Only an incomplete final line is retained between reads,
/// which keeps startup memory bounded and prevents old envelopes from being
/// reparsed for every stdout chunk.
struct SidecarStartupProtocolParser {
    private var pending = Data()
    private let capacity = 64 * 1024

    mutating func append(_ chunk: Data) -> [SidecarStartupEvent] {
        pending.append(chunk)
        var events = drainCompleteLines()
        if pending.count > capacity {
            pending.removeFirst(pending.count - capacity)
        }
        // The server normally emits NDJSON with a trailing newline, but a
        // fully formed envelope should still resolve immediately if stdout is
        // block-buffered or the final newline is delayed.
        if let event = Self.decodeLine(pending) {
            events.append(event)
            pending.removeAll(keepingCapacity: false)
        }
        return events
    }

    mutating func finish() -> [SidecarStartupEvent] {
        guard !pending.isEmpty else { return [] }
        let finalLine = pending
        pending.removeAll(keepingCapacity: false)
        return Self.decodeLine(finalLine).map { [$0] } ?? []
    }

    static func latestFailure(in text: String) -> SidecarStartupFailure? {
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let data = trimmed.data(using: .utf8),
                  case .failure(let failure) = decodeLine(data) else { continue }
            return failure
        }
        return nil
    }

    private mutating func drainCompleteLines() -> [SidecarStartupEvent] {
        var events: [SidecarStartupEvent] = []
        while let newlineIndex = pending.firstIndex(of: 0x0A) {
            let line = pending[..<newlineIndex]
            pending.removeSubrange(...newlineIndex)
            if let event = Self.decodeLine(Data(line)) {
                events.append(event)
            }
        }
        return events
    }

    private static func decodeLine(_ data: Data) -> SidecarStartupEvent? {
        guard !data.isEmpty,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else {
            return nil
        }

        switch envelope.status {
        case "ready":
            guard let port = envelope.port else { return nil }
            return .ready(port: port)
        case "error":
            return .failure(
                SidecarStartupFailure(
                    code: envelope.code ?? "unknown",
                    message: envelope.message ?? "Sidecar failed to start",
                    recoverable: envelope.recoverable ?? false,
                    details: envelope.details
                )
            )
        default:
            return nil
        }
    }

    private struct Envelope: Decodable {
        let status: String
        let port: Int?
        let code: String?
        let message: String?
        let recoverable: Bool?
        let details: String?
    }
}

/// Thread-safe rolling capture used only until startup resolves. Child pipe
/// handlers write on background queues while process termination reads it.
final class SidecarStartupErrorBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private let capacity: Int

    init(capacity: Int = 64 * 1024) {
        self.capacity = capacity
    }

    func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(chunk)
        if buffer.count > capacity {
            buffer.removeFirst(buffer.count - capacity)
        }
    }

    func latestFailure() -> SidecarStartupFailure? {
        lock.lock()
        defer { lock.unlock() }
        let text = String(decoding: buffer, as: UTF8.self)
        return SidecarStartupProtocolParser.latestFailure(in: text)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        buffer.removeAll(keepingCapacity: false)
    }
}

/// Serializes access to the incremental parser because FileHandle invokes its
/// readability handler outside the main actor.
final class SynchronizedSidecarStartupParser: @unchecked Sendable {
    private let lock = NSLock()
    private var parser = SidecarStartupProtocolParser()

    func append(_ chunk: Data) -> [SidecarStartupEvent] {
        lock.lock()
        defer { lock.unlock() }
        return parser.append(chunk)
    }

    func finish() -> [SidecarStartupEvent] {
        lock.lock()
        defer { lock.unlock() }
        return parser.finish()
    }
}

struct SidecarRestartPolicy {
    let maximumAttempts: Int
    let initialDelay: TimeInterval
    let maximumDelay: TimeInterval

    static let standard = SidecarRestartPolicy(
        maximumAttempts: 8,
        initialDelay: 0.4,
        maximumDelay: 10
    )

    func delay(forAttempt attempt: Int) -> TimeInterval? {
        guard attempt > 0, attempt <= maximumAttempts else { return nil }
        return min(pow(2, Double(attempt - 1)) * initialDelay, maximumDelay)
    }
}
