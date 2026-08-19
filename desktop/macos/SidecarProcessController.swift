import Darwin
import Foundation
import os

struct SidecarProcessConfiguration {
    let executableURL: URL
    let arguments: [String]
    let currentDirectoryURL: URL
    let environment: [String: String]
}

@MainActor
final class SidecarProcessController {
    typealias UnexpectedExitHandler = @MainActor (_ reason: String) -> Void

    private var process: Process?
    private var logFileHandle: FileHandle?
    private var stderrTailHandle: FileHandle?
    private var stdoutTailHandle: FileHandle?
    private weak var expectedTerminationProcess: Process?
    private let logFileURL: URL
    private let logger = Logger(subsystem: "com.verso.app", category: "SidecarProcess")

    init(logFileURL: URL) {
        self.logFileURL = logFileURL
    }

    nonisolated static var defaultLogFileURL: URL {
        let logsDirectory = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("verso", isDirectory: true)
        try? FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        return logsDirectory.appendingPathComponent("sidecar.log")
    }

    var isRunning: Bool {
        process?.isRunning == true
    }

    func launch(
        configuration: SidecarProcessConfiguration,
        onUnexpectedExit: @escaping UnexpectedExitHandler
    ) async throws -> Int {
        precondition(process == nil, "Cannot launch a second sidecar process")

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = configuration.executableURL
        process.arguments = configuration.arguments
        process.currentDirectoryURL = configuration.currentDirectoryURL
        process.environment = configuration.environment
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        self.process = process
        do {
            try process.run()
        } catch {
            self.process = nil
            throw error
        }

        let logHandle = Self.openLogHandle(at: logFileURL)
        logFileHandle = logHandle
        stderrTailHandle = stderrPipe.fileHandleForReading
        stdoutTailHandle = stdoutPipe.fileHandleForReading

        if let logHandle {
            Self.appendToLog(
                handle: logHandle,
                text: "\n[verso] launching sidecar pid=\(process.processIdentifier) at \(Self.timestamp())\n"
            )
        }

        let stderrBuffer = SidecarStartupErrorBuffer()
        let stderrReader = stderrPipe.fileHandleForReading
        stderrReader.readabilityHandler = { [weak self, weak logHandle] handle in
            let chunk = handle.availableData
            if chunk.isEmpty { return }
            if let logHandle {
                Self.appendToLog(handle: logHandle, data: chunk, prefix: "[stderr] ")
            }
            stderrBuffer.append(chunk)
            if let text = String(data: chunk, encoding: .utf8) {
                self?.logger.debug("sidecar stderr: \(text, privacy: .public)")
            }
        }

        do {
            let port: Int = try await withCheckedThrowingContinuation { continuation in
                let resolver = SidecarStartupResolver(continuation: continuation)
                let startupParser = SynchronizedSidecarStartupParser()

                process.terminationHandler = { [weak self, weak logHandle] terminatedProcess in
                    let reason = Self.describeTermination(terminatedProcess)
                    Task { @MainActor in
                        guard let self else { return }
                        if let logHandle {
                            Self.appendToLog(
                                handle: logHandle,
                                text: "\n[verso] sidecar exited: \(reason) at \(Self.timestamp())\n"
                            )
                        }

                        let isCurrentProcess = self.process === terminatedProcess
                        let wasExpected = self.expectedTerminationProcess === terminatedProcess
                        if isCurrentProcess {
                            self.process = nil
                            self.clearIOResources()
                        }

                        if !resolver.isResolved() {
                            if let startup = stderrBuffer.latestFailure() {
                                resolver.resume(.failure(SidecarProcessError.startupFailed(startup)))
                            } else {
                                resolver.resume(.failure(SidecarProcessError.unexpectedExit))
                            }
                            return
                        }

                        guard isCurrentProcess, !wasExpected else { return }
                        onUnexpectedExit(reason)
                    }
                }

                let stdoutReader = stdoutPipe.fileHandleForReading
                stdoutReader.readabilityHandler = { [weak self, weak logHandle] handle in
                    let chunk = handle.availableData
                    if chunk.isEmpty {
                        if !resolver.isResolved() {
                            for event in startupParser.finish() {
                                if resolver.resolve(event) {
                                    if case .ready = event { stderrBuffer.clear() }
                                    return
                                }
                            }
                            if let startup = stderrBuffer.latestFailure() {
                                resolver.resume(.failure(SidecarProcessError.startupFailed(startup)))
                            } else {
                                resolver.resume(.failure(SidecarProcessError.unexpectedExit))
                            }
                        }
                        return
                    }

                    if let logHandle {
                        Self.appendToLog(handle: logHandle, data: chunk, prefix: "[stdout] ")
                    }
                    self?.logger.debug("sidecar stdout chunk: \(chunk.count) bytes")

                    if resolver.isResolved() { return }
                    for event in startupParser.append(chunk) {
                        if resolver.resolve(event) {
                            if case .ready = event { stderrBuffer.clear() }
                            return
                        }
                    }
                }
            }
            guard process.isRunning, self.process === process else {
                throw SidecarProcessError.unexpectedExit
            }
            return port
        } catch {
            if self.process === process {
                stopImmediately()
            }
            throw error
        }
    }

    func stopImmediately() {
        let process = detachCurrentProcess()
        expectedTerminationProcess = process
        if process?.isRunning == true {
            process?.terminate()
        }
        clearIOResources()
        expectedTerminationProcess = nil
    }

    func stopGracefully(
        terminationTimeout: Duration = .seconds(5),
        killTimeout: Duration = .seconds(1)
    ) async -> Bool {
        guard let process else {
            clearIOResources()
            return true
        }
        expectedTerminationProcess = process

        if process.isRunning {
            process.terminate()
        }

        var didExit = await waitForExit(process, timeout: terminationTimeout)
        if !didExit, process.isRunning, !Task.isCancelled {
            logger.warning("Sidecar did not exit after SIGTERM; sending SIGKILL")
            Darwin.kill(process.processIdentifier, SIGKILL)
            didExit = await waitForExit(process, timeout: killTimeout)
        }

        if self.process === process {
            self.process = nil
        }
        clearIOResources()
        expectedTerminationProcess = nil
        return didExit || !process.isRunning
    }

    private func detachCurrentProcess() -> Process? {
        defer { process = nil }
        return process
    }

    private func waitForExit(_ process: Process, timeout: Duration) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while process.isRunning, clock.now < deadline {
            if Task.isCancelled { return false }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return !process.isRunning
    }

    private func clearIOResources() {
        stderrTailHandle?.readabilityHandler = nil
        stdoutTailHandle?.readabilityHandler = nil
        stderrTailHandle = nil
        stdoutTailHandle = nil
        try? logFileHandle?.close()
        logFileHandle = nil
    }

    deinit {
        if process?.isRunning == true {
            process?.terminate()
        }
    }

    nonisolated private static func describeTermination(_ process: Process) -> String {
        switch process.terminationReason {
        case .exit:
            return "exit code=\(process.terminationStatus)"
        case .uncaughtSignal:
            return "signal=\(process.terminationStatus)"
        @unknown default:
            return "unknown reason status=\(process.terminationStatus)"
        }
    }

    nonisolated private static func openLogHandle(at url: URL) -> FileHandle? {
        let fileManager = FileManager.default
        try? fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !fileManager.fileExists(atPath: url.path) {
            fileManager.createFile(atPath: url.path, contents: nil)
        }
        if let attributes = try? fileManager.attributesOfItem(atPath: url.path),
           let size = attributes[.size] as? UInt64,
           size > 5 * 1024 * 1024 {
            try? Data().write(to: url)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return nil }
        _ = try? handle.seekToEnd()
        return handle
    }

    nonisolated private static func appendToLog(handle: FileHandle, text: String) {
        guard let data = text.data(using: .utf8) else { return }
        try? handle.write(contentsOf: data)
    }

    nonisolated private static func appendToLog(handle: FileHandle, data: Data, prefix: String) {
        guard let prefixData = prefix.data(using: .utf8) else { return }
        try? handle.write(contentsOf: prefixData)
        try? handle.write(contentsOf: data)
    }

    nonisolated private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

private final class SidecarStartupResolver: @unchecked Sendable {
    private let lock = NSLock()
    private var resolved = false
    private let continuation: CheckedContinuation<Int, Error>

    init(continuation: CheckedContinuation<Int, Error>) {
        self.continuation = continuation
    }

    func isResolved() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return resolved
    }

    @discardableResult
    func resolve(_ event: SidecarStartupEvent) -> Bool {
        switch event {
        case .ready(let port):
            return resume(.success(port))
        case .failure(let failure):
            return resume(.failure(SidecarProcessError.startupFailed(failure)))
        }
    }

    @discardableResult
    func resume(_ result: Result<Int, Error>) -> Bool {
        lock.lock()
        if resolved {
            lock.unlock()
            return false
        }
        resolved = true
        lock.unlock()
        continuation.resume(with: result)
        return true
    }
}

enum SidecarProcessError: LocalizedError {
    case startupFailed(SidecarStartupFailure)
    case unexpectedExit

    var errorDescription: String? {
        switch self {
        case .startupFailed(let startup):
            if startup.code == "unknown" {
                return "Sidecar failed to start: \(startup.message)"
            }
            return "Sidecar startup failed (\(startup.code)): \(startup.message)"
        case .unexpectedExit:
            return "Sidecar exited before becoming ready"
        }
    }
}
