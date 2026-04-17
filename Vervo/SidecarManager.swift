import Foundation
import os

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
            proc.waitUntilExit()
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
        let proc = Process()
        let pipe = Pipe()

        // Resolve research-core directory relative to the repo
        let serverDir = Self.researchCorePath()
        guard FileManager.default.fileExists(atPath: serverDir) else {
            throw SidecarError.directoryNotFound(serverDir)
        }

        // Clean up stale PGLite locks from previous crashed runs
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

        // Capture stderr for debugging
        let stderrPipe = Pipe()
        proc.standardError = stderrPipe
        stderrPipe.fileHandleForReading.readabilityHandler = { [logger] fh in
            let data = fh.availableData
            if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
                logger.error("sidecar stderr: \(text)")
            }
        }

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

        // Read stdout on a background thread until we get the ready JSON line
        let handle = pipe.fileHandleForReading
        let port: Int = try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var buffer = Data()
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty {
                        continuation.resume(throwing: SidecarError.unexpectedExit)
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
        let appSupport = NSHomeDirectory() + "/Library/Application Support/Vervo"
        let dbPath = appSupport + "/brain.db"
        let fm = FileManager.default
        // Remove postmaster.pid (PGLite WASM lock)
        let pid = dbPath + "/postmaster.pid"
        if fm.fileExists(atPath: pid) { try? fm.removeItem(atPath: pid) }
        // Remove gbrain advisory lock directory
        let lockDir = dbPath + "/.gbrain-lock"
        if fm.fileExists(atPath: lockDir) { try? fm.removeItem(atPath: lockDir) }
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

enum SidecarError: LocalizedError {
    case executableNotFound(String)
    case directoryNotFound(String)
    case unexpectedExit
    case timeout

    var errorDescription: String? {
        switch self {
        case .executableNotFound(let name): return "\(name) not found in PATH"
        case .directoryNotFound(let path): return "research-core not found at \(path)"
        case .unexpectedExit: return "Sidecar exited before becoming ready"
        case .timeout: return "Sidecar did not start within timeout"
        }
    }
}
