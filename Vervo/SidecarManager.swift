import Foundation
import os
import Darwin

/// Manages the research-core Node.js sidecar process lifecycle.
/// Spawns the HTTP server, reads the port from stdout, and tears down on deinit.
@MainActor
final class SidecarManager: ObservableObject {
    enum State: Equatable {
        case idle
        case starting
        case running(port: Int)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private var process: Process?
    private var stdoutPipe: Pipe?
    private let logger = Logger(subsystem: "com.vervo.app", category: "Sidecar")

    var port: Int? {
        if case .running(let p) = state { return p }
        return nil
    }

    var baseURL: URL? {
        port.map { URL(string: "http://127.0.0.1:\($0)")! }
    }

    func start() {
        guard state == .idle || {
            if case .failed = state { return true }
            return false
        }() else { return }

        state = .starting

        Task {
            do {
                let detectedPort = try await launchProcess()
                state = .running(port: detectedPort)
                logger.info("Sidecar running on port \(detectedPort)")
            } catch {
                state = .failed(error.localizedDescription)
                logger.error("Sidecar failed: \(error.localizedDescription)")
            }
        }
    }

    func stop() {
        if let proc = process, proc.isRunning {
            proc.terminate()
            logger.info("Sidecar stopped")
        }
        process = nil
        stdoutPipe = nil
        state = .idle
    }

    deinit {
        // Process cleanup — can't call stop() because we're in deinit
        if let proc = process, proc.isRunning {
            proc.terminate()
        }
    }

    // MARK: - Private

    private func launchProcess() async throws -> Int {
        var attemptedRecovery = false
        while true {
            do {
                return try await launchProcessOnce()
            } catch SidecarError.startupFailed(let startup)
                where !attemptedRecovery && Self.shouldAttemptRecovery(for: startup) {
                attemptedRecovery = true
                logger.error("Recoverable sidecar startup failure (\(startup.code)): \(startup.message)")
                try Self.rotateDatabaseForRecovery(logger: logger)
                continue
            }
        }
    }

    private func launchProcessOnce() async throws -> Int {
        let proc = Process()
        let pipe = Pipe()
        let stderrPipe = Pipe()

        // Resolve research-core directory relative to the repo
        let serverDir = Self.researchCorePath()
        guard FileManager.default.fileExists(atPath: serverDir) else {
            throw SidecarError.directoryNotFound(serverDir)
        }

        // Clean up stale PGLite locks from previous crashed runs
        Self.terminateOrphanSidecars(serverDir: serverDir, logger: logger)
        Self.cleanStaleLocks()

        // Find node
        guard let nodePath = Self.findExecutable("node") else {
            throw SidecarError.executableNotFound("node")
        }

        // Use the locally-installed tsx binary
        let tsxBin = (serverDir as NSString).appendingPathComponent("node_modules/.bin/tsx")
        guard FileManager.default.isExecutableFile(atPath: tsxBin) else {
            throw SidecarError.executableNotFound("tsx (run npm install in research-core)")
        }

        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [tsxBin, "src/http/server.ts"]
        proc.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        proc.standardOutput = pipe
        proc.standardError = stderrPipe

        // Inherit PATH
        var env = ProcessInfo.processInfo.environment
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        let currentPath = env["PATH"] ?? ""
        env["PATH"] = (extraPaths + [currentPath]).joined(separator: ":")
        proc.environment = env

        logger.info("Launching sidecar: \(nodePath) \(tsxBin) src/http/server.ts")
        logger.info("Working directory: \(serverDir)")

        self.process = proc
        self.stdoutPipe = pipe

        try proc.run()

        let handle = pipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading
        let logger = self.logger

        // Read stdout on a background thread until we get the ready JSON line
        let port: Int = try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var buffer = Data()
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty {
                        let stderrData = stderrHandle.readDataToEndOfFile()
                        let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
                        if !stderrText.isEmpty {
                            logger.error("sidecar stderr: \(stderrText)")
                        }
                        if let startup = Self.parseStartupError(stderrText) {
                            continuation.resume(throwing: SidecarError.startupFailed(startup))
                        } else {
                            continuation.resume(throwing: SidecarError.unexpectedExit)
                        }
                        return
                    }
                    buffer.append(chunk)
                    guard let text = String(data: buffer, encoding: .utf8) else { continue }
                    for line in text.split(separator: "\n") {
                        guard let jsonData = line.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                              let status = obj["status"] as? String, status == "ready",
                              let port = obj["port"] as? Int else { continue }
                        continuation.resume(returning: port)
                        return
                    }
                }
            }
        }

        // Monitor for unexpected termination
        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in
                guard let self = self else { return }
                if case .running = self.state {
                    self.state = .failed("Sidecar exited with code \(p.terminationStatus)")
                    self.logger.error("Sidecar exited unexpectedly: \(p.terminationStatus)")
                }
            }
        }

        return port
    }

    /// Remove stale PGLite lock files left by crashed sidecar processes.
    private static func cleanStaleLocks() {
        let dbPath = databasePath()
        let fm = FileManager.default

        // Remove stale postmaster.pid (PGLite WASM lock) only if the PID is no longer alive.
        let pid = dbPath + "/postmaster.pid"
        if fm.fileExists(atPath: pid) {
            if let raw = try? String(contentsOfFile: pid, encoding: .utf8),
               let first = raw.split(separator: "\n").first,
               let pidValue = Int32(first),
               isProcessAlive(pidValue) {
                // Active process still owns this lock; don't remove.
            } else {
                try? fm.removeItem(atPath: pid)
            }
        }

        // Remove stale gbrain advisory lock only if owner process is dead or lock is very old.
        let lockDir = dbPath + "/.gbrain-lock"
        let lockFile = lockDir + "/lock"
        if fm.fileExists(atPath: lockDir) {
            var shouldRemove = false

            if let data = try? Data(contentsOf: URL(fileURLWithPath: lockFile)),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let pidValue = (obj["pid"] as? NSNumber)?.int32Value
                let acquiredAt = (obj["acquired_at"] as? NSNumber)?.doubleValue ?? 0
                let ageMs = Date().timeIntervalSince1970 * 1000 - acquiredAt
                if let pidValue {
                    shouldRemove = !isProcessAlive(pidValue) || ageMs > 5 * 60 * 1000
                } else {
                    shouldRemove = true
                }
            } else {
                // Corrupt or missing lock metadata; treat as stale.
                shouldRemove = true
            }

            if shouldRemove {
                try? fm.removeItem(atPath: lockDir)
            }
        }
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

            let code = (obj["code"] as? String) ?? "unknown"
            let message = (obj["message"] as? String) ?? "Sidecar startup failed"
            let recoverable = (obj["recoverable"] as? Bool) ?? false
            let details = obj["details"] as? String
            return SidecarStartupFailure(code: code, message: message, recoverable: recoverable, details: details)
        }

        guard let fallback = lines.last else { return nil }
        return SidecarStartupFailure(
            code: "unknown",
            message: fallback,
            recoverable: false,
            details: fallback
        )
    }

    private static func shouldAttemptRecovery(for startup: SidecarStartupFailure) -> Bool {
        if startup.recoverable { return true }
        return startup.code == "db_corrupt" || startup.code == "migration_failed"
    }

    private static func rotateDatabaseForRecovery(logger: Logger) throws {
        let dbPath = databasePath()
        let fm = FileManager.default
        guard fm.fileExists(atPath: dbPath) else { return }

        let parent = (dbPath as NSString).deletingLastPathComponent
        let timestamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let backup = (parent as NSString).appendingPathComponent("brain.db.corrupt-\(timestamp)")

        try fm.moveItem(atPath: dbPath, toPath: backup)
        logger.error("Rotated suspect DB to \(backup)")
    }

    private static func databasePath() -> String {
        let appSupport = NSHomeDirectory() + "/Library/Application Support/Vervo"
        let configPath = appSupport + "/config.json"

        if let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let configured = obj["database_path"] as? String,
           !configured.isEmpty {
            if configured.hasPrefix("/") {
                return configured
            }
            return (appSupport as NSString).appendingPathComponent(configured)
        }

        return appSupport + "/brain.db"
    }

    private static func isProcessAlive(_ pid: Int32) -> Bool {
        if pid <= 0 { return false }
        if kill(pid, 0) == 0 { return true }
        // EPERM means process exists but we don't have permission.
        return errno == EPERM
    }

    /// Terminate orphan sidecars for this workspace so a fresh launch can acquire DB locks.
    private static func terminateOrphanSidecars(serverDir: String, logger: Logger) {
        let marker = "\(serverDir)/node_modules/.bin/tsx src/http/server.ts"

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        task.arguments = ["-f", marker]
        task.standardOutput = Pipe()
        task.standardError = Pipe()

        do {
            try task.run()
            task.waitUntilExit()
            // pkill exits 0 when it matched/killed at least one process, 1 when no match.
            if task.terminationStatus == 0 {
                logger.info("Terminated orphan sidecar processes matching marker")
            }
        } catch {
            logger.error("Failed to scan sidecar processes: \(error.localizedDescription)")
        }
    }

    /// Search common paths for an executable.
    private static func findExecutable(_ name: String) -> String? {
        let candidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "/usr/bin/\(name)",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        return nil
    }

    /// Path to the research-core directory.
    /// In development: relative to the repo. In production: bundled in the app.
    private static func researchCorePath() -> String {
        // Allow explicit override via environment variable.
        if let override = ProcessInfo.processInfo.environment["RESEARCH_CORE_PATH"] {
            return override
        }

        // Check if bundled inside the app (production).
        if let bundled = Bundle.main.resourcePath {
            let bundledPath = (bundled as NSString).appendingPathComponent("research-core")
            if FileManager.default.fileExists(atPath: bundledPath) {
                return bundledPath
            }
        }

        // Development: the Xcode project lives at <repo>/Vervo.xcodeproj, and
        // the source file that compiled this code lives at <repo>/Vervo/SidecarManager.swift.
        // Use #filePath (compile-time) to derive the repo root.
        let thisFile = #filePath                          // .../port-louis/Vervo/SidecarManager.swift
        let vervoDir = (thisFile as NSString).deletingLastPathComponent  // .../port-louis/Vervo
        let repoRoot = (vervoDir as NSString).deletingLastPathComponent  // .../port-louis
        let candidate = (repoRoot as NSString).appendingPathComponent("research-core")
        if FileManager.default.fileExists(atPath: candidate) {
            return candidate
        }

        // Last resort fallback.
        return (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent("research-core")
    }
}

struct SidecarStartupFailure {
    let code: String
    let message: String
    let recoverable: Bool
    let details: String?
}

enum SidecarError: LocalizedError {
    case executableNotFound(String)
    case directoryNotFound(String)
    case startupFailed(SidecarStartupFailure)
    case unexpectedExit
    case timeout

    var errorDescription: String? {
        switch self {
        case .executableNotFound(let name): return "\(name) not found in PATH"
        case .directoryNotFound(let path): return "research-core not found at \(path)"
        case .startupFailed(let startup):
            if startup.code == "unknown" {
                return "Sidecar failed to start: \(startup.message)"
            }
            return "Sidecar startup failed (\(startup.code)): \(startup.message)"
        case .unexpectedExit: return "Sidecar exited before becoming ready"
        case .timeout: return "Sidecar did not start within timeout"
        }
    }
}
