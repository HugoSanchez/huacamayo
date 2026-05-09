import Foundation
import os

/// Manages the local Node.js sidecar process lifecycle.
@MainActor
final class SidecarManager: ObservableObject {
    enum State: Equatable {
        case idle
        case starting
        case running(port: Int)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var managedSession: ManagedAppSession?
    @Published private(set) var managedAccount: ManagedAccountSnapshot?

    private var process: Process?
    private var logFileHandle: FileHandle?
    private var stderrTailHandle: FileHandle?
    private var stdoutTailHandle: FileHandle?
    private var activityToken: NSObjectProtocol?
    private var stopRequested = false
    private var restartAttempts = 0
    private let maxRestartAttempts = 8
    private let logger = Logger(subsystem: "com.vervo.app", category: "Sidecar")

    struct ManagedAccountSnapshot: Equatable, Decodable {
        struct Backend: Equatable, Decodable {
            let configured: Bool
            let baseUrl: String?
        }

        struct Session: Equatable, Decodable {
            let present: Bool
            let userId: String?
            let email: String?
            let displayName: String?
            let expiresAt: String?
            let receivedAt: String?
            let expired: Bool
        }

        struct User: Equatable, Decodable {
            let id: String
            let privyUserId: String
            let email: String?
            let displayName: String?
        }

        struct Device: Equatable, Decodable {
            let id: String
            let label: String
            let platform: String
            let lastSeenAt: String
        }

        struct AuthSession: Equatable, Decodable {
            let id: String
            let issuedAt: String
            let expiresAt: String
        }

        struct Entitlement: Equatable, Decodable {
            let id: String
            let mode: String
            let status: String
            let allowedModels: [String]
            let monthlyUsdLimit: Double?
            let dailyUsdLimit: Double?
        }

        struct Account: Equatable, Decodable {
            let state: String
            let error: String?
            let user: User?
            let device: Device?
            let session: AuthSession?
            let entitlements: [Entitlement]
        }

        let backend: Backend
        let session: Session
        let account: Account
    }

    /// Path to the on-disk sidecar log. Returned even before the sidecar
    /// starts so the UI can offer a "reveal in Finder" affordance.
    static var logFileURL: URL {
        let logsDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("Vervo", isDirectory: true)
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        return logsDir.appendingPathComponent("sidecar.log")
    }

    var port: Int? {
        if case .running(let port) = state {
            return port
        }
        return nil
    }

    var baseURL: URL? {
        port.map { URL(string: "http://127.0.0.1:\($0)")! }
    }

    func updateManagedSession(_ session: ManagedAppSession?) {
        managedSession = session
        if let session {
            logger.info("Managed backend session updated for user \(session.userId, privacy: .public)")
        } else {
            logger.info("Managed backend session cleared")
        }
        if port != nil {
            Task {
                await pushManagedSession(session)
                await refreshManagedAccount()
            }
        } else if session == nil {
            managedAccount = nil
        }
    }

    func start() {
        guard state == .idle || {
            if case .failed = state { return true }
            return false
        }() else { return }

        stopRequested = false
        beginActivityIfNeeded()
        state = .starting

        Task {
            do {
                let detectedPort = try await launchProcess()
                state = .running(port: detectedPort)
                restartAttempts = 0
                logger.info("Sidecar running on port \(detectedPort)")
                await refreshManagedAccount()
            } catch {
                state = .failed(error.localizedDescription)
                logger.error("Sidecar failed: \(error.localizedDescription)")
                scheduleRestart()
            }
        }
    }

    func stop() {
        stopRequested = true
        if let process, process.isRunning {
            process.terminate()
            logger.info("Sidecar stopped")
        }
        self.process = nil
        stderrTailHandle?.readabilityHandler = nil
        stdoutTailHandle?.readabilityHandler = nil
        stderrTailHandle = nil
        stdoutTailHandle = nil
        try? logFileHandle?.close()
        logFileHandle = nil
        endActivityIfNeeded()
        managedAccount = nil
        state = .idle
    }

    func refreshManagedAccount() async {
        guard let baseURL else {
            managedAccount = nil
            return
        }

        let endpoint = baseURL.appendingPathComponent("managed/account")
        do {
            let (data, response) = try await URLSession.shared.data(from: endpoint)
            guard let http = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(http.statusCode) else {
                throw NSError(
                    domain: "Vervo.SidecarManager",
                    code: http.statusCode,
                    userInfo: [NSLocalizedDescriptionKey: "Managed account request failed with HTTP \(http.statusCode)."]
                )
            }
            let decoded = try JSONDecoder().decode(ManagedAccountSnapshot.self, from: data)
            managedAccount = decoded
        } catch {
            logger.error("Managed account refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Push the current managed session into the orchestrator's in-memory store
    /// over loopback IPC. The orchestrator never persists the bearer token; on
    /// sidecar restart we re-seed via env vars in `launchProcess`.
    private func pushManagedSession(_ session: ManagedAppSession?) async {
        guard let baseURL else { return }
        let endpoint = baseURL.appendingPathComponent("managed/session")
        var request = URLRequest(url: endpoint)

        if let session {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                request.httpBody = try JSONEncoder().encode(session)
            } catch {
                logger.error("Failed to encode managed session for push: \(error.localizedDescription, privacy: .public)")
                return
            }
        } else {
            request.httpMethod = "DELETE"
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                logger.error("Managed session push returned HTTP \(http.statusCode, privacy: .public)")
            }
        } catch {
            logger.error("Managed session push failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    deinit {
        if let process, process.isRunning {
            process.terminate()
        }
    }

    /// Tell macOS this app is doing a long-running, user-initiated task so
    /// App Nap / RunningBoard don't aggressively reap our child Node process.
    /// We don't disable system sleep — only App Nap & sudden/automatic
    /// termination. Symptom this addresses: sidebar going empty after a
    /// minute of idle while the app is in the background, because macOS
    /// SIGTERM'd the orchestrator.
    private func beginActivityIfNeeded() {
        guard activityToken == nil else { return }
        activityToken = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "Vervo orchestrator must run continuously to serve the chat UI"
        )
    }

    private func endActivityIfNeeded() {
        if let activityToken {
            ProcessInfo.processInfo.endActivity(activityToken)
        }
        activityToken = nil
    }

    /// Auto-restart on unexpected exit. Backs off exponentially up to a cap;
    /// resets the counter on a successful start. If `stop()` was called
    /// explicitly, we never restart.
    private func scheduleRestart() {
        guard !stopRequested else { return }
        guard restartAttempts < maxRestartAttempts else {
            logger.error("Sidecar restart attempts exhausted (\(self.maxRestartAttempts)). Giving up.")
            return
        }
        restartAttempts += 1
        // 0.4, 0.8, 1.6, 3.2, ... capped at 10s.
        let delay = min(pow(2.0, Double(restartAttempts - 1)) * 0.4, 10.0)
        logger.info("Restarting sidecar (attempt \(self.restartAttempts)) in \(delay, format: .fixed(precision: 2))s")
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.stopRequested else { return }
            // Force re-entry: start() requires .idle or .failed; we're in
            // .failed now, so the guard passes.
            self.start()
        }
    }

    private func launchProcess() async throws -> Int {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        let serverDir = Self.orchestratorPath()
        guard FileManager.default.fileExists(atPath: serverDir) else {
            throw SidecarError.directoryNotFound(serverDir)
        }

        guard let nodePath = Self.findExecutable("node") else {
            throw SidecarError.executableNotFound("node")
        }

        let tsxBin = (serverDir as NSString).appendingPathComponent("node_modules/.bin/tsx")
        guard FileManager.default.isExecutableFile(atPath: tsxBin) else {
            throw SidecarError.executableNotFound("tsx (run npm install in the sidecar package)")
        }

        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [tsxBin, "src/http/server.ts"]
        process.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let extraPaths = [
            "\(home)/.local/bin",
            "\(home)/.hermes/hermes-agent/venv/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
        ]
        let currentPath = env["PATH"] ?? ""
        env["PATH"] = (extraPaths + [currentPath]).joined(separator: ":")
        if let managedSession, !managedSession.isExpired {
            env["VERVO_MANAGED_SESSION_TOKEN"] = managedSession.token
            env["VERVO_MANAGED_SESSION_EXPIRES_AT"] = managedSession.expiresAt
            env["VERVO_MANAGED_USER_ID"] = managedSession.userId
        }
        // The orchestrator polls this pid every few seconds; if it goes away
        // (we crashed, were force-quit, were stopped from Xcode without a
        // graceful shutdown), the orchestrator self-exits. Without this, the
        // sidecar gets re-parented to launchd and keeps spinning forever.
        env["VERVO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = env

        logger.info("Launching sidecar: \(nodePath) \(tsxBin) src/http/server.ts")
        logger.info("Working directory: \(serverDir)")
        if let command = env["VERVO_HERMES_COMMAND"], !command.isEmpty {
            logger.info("Agent runtime launch mode: managed command \(command)")
        } else {
            logger.info("Agent runtime launch mode: auto-detect installed CLI")
        }

        self.process = process

        try process.run()

        // Open the persistent log file before the child writes anything so we
        // never lose output. Append-mode keeps history across restarts; we
        // truncate manually if it grows past a hard cap.
        let logURL = Self.logFileURL
        let logHandle = Self.openLogHandle(at: logURL)
        self.logFileHandle = logHandle
        self.stderrTailHandle = stderrPipe.fileHandleForReading
        self.stdoutTailHandle = stdoutPipe.fileHandleForReading

        let startMarker = "\n[vervo] launching sidecar pid=\(process.processIdentifier) at \(Self.timestamp())\n"
        if let logHandle {
            Self.appendToLog(handle: logHandle, text: startMarker)
        }

        // We track stderr during startup so we can surface structured
        // failure envelopes (`{"status":"error", ...}`) the server emits
        // before exiting. Once the sidecar reaches "ready" we stop buffering
        // and only forward to the log file.
        let stderrBuffer = StderrBuffer()
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

        let port: Int = try await withCheckedThrowingContinuation { continuation in
            // Mutable state captured by the FileHandle readabilityHandler runs
            // on a background queue, so wrap it in a thread-safe holder to
            // satisfy Swift's concurrency checker. The holder also makes the
            // resume call idempotent.
            let resolver = StartupResolver(continuation: continuation)
            let stdoutAccumulator = StdoutAccumulator()

            let stdoutReader = stdoutPipe.fileHandleForReading
            stdoutReader.readabilityHandler = { [weak self, weak logHandle] handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    if !resolver.isResolved() {
                        let stderrText = stderrBuffer.text()
                        if let startup = Self.parseStartupError(stderrText) {
                            resolver.resume(.failure(SidecarError.startupFailed(startup)))
                        } else {
                            resolver.resume(.failure(SidecarError.unexpectedExit))
                        }
                    }
                    return
                }

                if let logHandle {
                    Self.appendToLog(handle: logHandle, data: chunk, prefix: "[stdout] ")
                }
                self?.logger.debug("sidecar stdout chunk: \(chunk.count) bytes")

                if resolver.isResolved() { return }

                let text = stdoutAccumulator.appendAndDecode(chunk)
                for line in text.split(separator: "\n") {
                    guard let jsonData = line.data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                          let status = obj["status"] as? String else { continue }
                    if status == "ready", let port = obj["port"] as? Int {
                        // Free the startup buffer; from here on stderr only flows to the log file.
                        stderrBuffer.clear()
                        resolver.resume(.success(port))
                        return
                    }
                    if status == "error" {
                        let failure = SidecarStartupFailure(
                            code: obj["code"] as? String ?? "unknown",
                            message: obj["message"] as? String ?? "Sidecar failed to start",
                            recoverable: obj["recoverable"] as? Bool ?? false,
                            details: obj["details"] as? String
                        )
                        resolver.resume(.failure(SidecarError.startupFailed(failure)))
                        return
                    }
                }
            }
        }

        process.terminationHandler = { [weak self] process in
            let reason = Self.describeTermination(process)
            Task { @MainActor in
                guard let self else { return }
                if let handle = self.logFileHandle {
                    Self.appendToLog(handle: handle, text: "\n[vervo] sidecar exited: \(reason) at \(Self.timestamp())\n")
                }
                self.stderrTailHandle?.readabilityHandler = nil
                self.stdoutTailHandle?.readabilityHandler = nil
                self.stderrTailHandle = nil
                self.stdoutTailHandle = nil
                if case .running = self.state {
                    self.state = .failed("Sidecar exited: \(reason)")
                    self.logger.error("Sidecar exited unexpectedly: \(reason, privacy: .public). Log: \(Self.logFileURL.path, privacy: .public)")
                    self.scheduleRestart()
                }
            }
        }

        return port
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
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil)
        }
        // Cap the log at ~5 MB; truncate to start fresh once it gets too big.
        if let attrs = try? fm.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? UInt64,
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
        // Light-touch line-prefixing: just write the prefix once per chunk
        // so the file is greppable without paying for full per-line splitting
        // on the I/O path.
        guard let prefixData = prefix.data(using: .utf8) else { return }
        try? handle.write(contentsOf: prefixData)
        try? handle.write(contentsOf: data)
    }

    nonisolated private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    nonisolated private static func parseStartupError(_ stderrText: String) -> SidecarStartupFailure? {
        let lines = stderrText
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for line in lines.reversed() {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let status = obj["status"] as? String,
                  status == "error" else { continue }

            return SidecarStartupFailure(
                code: obj["code"] as? String ?? "unknown",
                message: obj["message"] as? String ?? "Sidecar failed to start",
                recoverable: obj["recoverable"] as? Bool ?? false,
                details: obj["details"] as? String
            )
        }

        return nil
    }

    private static func findExecutable(_ name: String) -> String? {
        let candidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "/usr/bin/\(name)",
        ]

        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }

        return nil
    }

    /// Path to the sidecar package directory.
    /// In development: relative to the repo. In production: bundled in the app.
    private static func orchestratorPath() -> String {
        if let override = ProcessInfo.processInfo.environment["ORCHESTRATOR_PATH"] {
            return override
        }

        if let bundled = Bundle.main.resourcePath {
            let bundledPath = (bundled as NSString).appendingPathComponent("orchestrator")
            if FileManager.default.fileExists(atPath: bundledPath) {
                return bundledPath
            }
        }

        let thisFile = #filePath
        let vervoDir = (thisFile as NSString).deletingLastPathComponent
        let repoRoot = (vervoDir as NSString).deletingLastPathComponent
        let candidate = (repoRoot as NSString).appendingPathComponent("orchestrator")
        if FileManager.default.fileExists(atPath: candidate) {
            return candidate
        }

        return (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent("orchestrator")
    }
}

struct SidecarStartupFailure {
    let code: String
    let message: String
    let recoverable: Bool
    let details: String?
}

// Thread-safe rolling buffer used to capture stderr during startup. Writes
// happen on the FileHandle reader queue, reads happen on the I/O continuation
// queue, so we serialize via a lock. Capped to keep memory bounded if the
// child is silently spewing.
private final class StderrBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private let cap = 64 * 1024

    func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(chunk)
        if buffer.count > cap {
            buffer.removeFirst(buffer.count - cap)
        }
    }

    func text() -> String {
        lock.lock()
        defer { lock.unlock() }
        return String(data: buffer, encoding: .utf8) ?? ""
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        buffer.removeAll(keepingCapacity: false)
    }
}

// One-shot resolver wrapping a CheckedContinuation. Calling resume() more
// than once is a fatal error in Swift's continuation model, so we serialize
// access and ignore subsequent resumes.
private final class StartupResolver: @unchecked Sendable {
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

    func resume(_ result: Result<Int, Error>) {
        lock.lock()
        if resolved {
            lock.unlock()
            return
        }
        resolved = true
        lock.unlock()
        continuation.resume(with: result)
    }
}

// Buffers stdout chunks during startup until we see the "ready" handshake.
// Wrapped in a class so the FileHandle readabilityHandler closure can mutate
// it without tripping Swift 6 strict-concurrency checks.
private final class StdoutAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()

    func appendAndDecode(_ chunk: Data) -> String {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(chunk)
        return String(data: buffer, encoding: .utf8) ?? ""
    }
}

enum SidecarError: LocalizedError {
    case executableNotFound(String)
    case directoryNotFound(String)
    case startupFailed(SidecarStartupFailure)
    case unexpectedExit

    var errorDescription: String? {
        switch self {
        case .executableNotFound(let name):
            return "\(name) not found in PATH"
        case .directoryNotFound(let path):
            return "sidecar package not found at \(path)"
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
