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

    private var process: Process?
    private let logger = Logger(subsystem: "com.vervo.app", category: "Sidecar")

    var port: Int? {
        if case .running(let port) = state {
            return port
        }
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
        if let process, process.isRunning {
            process.terminate()
            logger.info("Sidecar stopped")
        }
        self.process = nil
        state = .idle
    }

    deinit {
        if let process, process.isRunning {
            process.terminate()
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
        process.environment = env

        logger.info("Launching sidecar: \(nodePath) \(tsxBin) src/http/server.ts")
        logger.info("Working directory: \(serverDir)")
        if let command = env["VERVO_HERMES_COMMAND"], !command.isEmpty {
            logger.info("Hermes launch mode: managed command \(command)")
        } else {
            logger.info("Hermes launch mode: auto-detect installed CLI")
        }

        self.process = process

        try process.run()

        let port: Int = try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let handle = stdoutPipe.fileHandleForReading
                let stderrHandle = stderrPipe.fileHandleForReading
                var buffer = Data()

                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty {
                        let stderrData = stderrHandle.readDataToEndOfFile()
                        let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
                        if !stderrText.isEmpty {
                            self.logger.error("sidecar stderr: \(stderrText)")
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
                              let status = obj["status"] as? String,
                              status == "ready",
                              let port = obj["port"] as? Int else { continue }
                        continuation.resume(returning: port)
                        return
                    }
                }
            }
        }

        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self else { return }
                if case .running = self.state {
                    self.state = .failed("Sidecar exited with code \(process.terminationStatus)")
                    self.logger.error("Sidecar exited unexpectedly: \(process.terminationStatus)")
                }
            }
        }

        return port
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
