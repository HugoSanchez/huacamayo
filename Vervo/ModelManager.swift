import Foundation

/// Describes a GGUF model that Vervo needs to operate.
struct ModelDefinition: Identifiable {
    let id: String          // e.g. "bge-m3"
    let displayName: String // e.g. "BGE-M3 Embeddings"
    let filename: String    // local filename in models dir
    let remoteURL: URL      // HuggingFace download URL
    let expectedBytes: Int64
}

/// Manages checking and downloading GGUF models required by research-core.
///
/// Models live in ~/Library/Application Support/Vervo/models/ and persist
/// across builds, reinstalls, and Xcode clean builds.
@MainActor
final class ModelManager: NSObject, ObservableObject {

    // MARK: - Model catalog

    static let models: [ModelDefinition] = [
        ModelDefinition(
            id: "bge-m3",
            displayName: "BGE-M3 Embeddings",
            filename: "bge-m3-f16.gguf",
            remoteURL: URL(string: "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-FP16.gguf")!,
            expectedBytes: 1_157_671_200  // ~1.08 GB
        ),
        ModelDefinition(
            id: "qwen3-reranker",
            displayName: "Qwen3 Reranker",
            filename: "qwen3-reranker-0.6b-q8_0.gguf",
            remoteURL: URL(string: "https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf")!,
            expectedBytes: 639_153_184    // ~610 MB
        ),
    ]

    static let modelsDirectory: URL = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return appSupport.appendingPathComponent("Vervo/models", isDirectory: true)
    }()

    // MARK: - Published state

    enum Status: Equatable {
        case checking
        case ready
        case needsDownload
        case downloading
        case failed(String)
    }

    struct ModelProgress: Equatable {
        var bytesDownloaded: Int64 = 0
        var totalBytes: Int64 = 0
        var fraction: Double { totalBytes > 0 ? Double(bytesDownloaded) / Double(totalBytes) : 0 }
    }

    @Published var status: Status = .checking
    @Published var missingModels: [ModelDefinition] = []
    @Published var progressByModel: [String: ModelProgress] = [:]
    @Published var currentModelName: String = ""

    // MARK: - Internal

    private var downloadTask: Task<Void, Never>?
    private var activeDownload: URLSessionDownloadTask?
    private var downloadContinuation: CheckedContinuation<URL, Error>?
    private var currentModelId: String?

    // MARK: - Check

    /// Returns true if all models are present on disk.
    /// Pass `forceNeedsDownload: true` to skip the check and show the wizard (for UI development).
    @discardableResult
    func checkModels(forceNeedsDownload: Bool = false) -> Bool {
        if forceNeedsDownload {
            missingModels = Self.models
            status = .needsDownload
            return false
        }
        let fm = FileManager.default
        var missing: [ModelDefinition] = []
        for model in Self.models {
            let path = Self.modelsDirectory.appendingPathComponent(model.filename)
            if !fm.fileExists(atPath: path.path) {
                missing.append(model)
            } else {
                // Basic size sanity check — if the file is suspiciously small
                // (e.g. interrupted download), treat it as missing.
                if let attrs = try? fm.attributesOfItem(atPath: path.path),
                   let size = attrs[.size] as? Int64,
                   size < model.expectedBytes / 2 {
                    missing.append(model)
                }
            }
        }
        missingModels = missing
        if missing.isEmpty {
            status = .ready
            return true
        } else {
            status = .needsDownload
            return false
        }
    }

    // MARK: - Download

    func downloadMissing() {
        guard !missingModels.isEmpty else {
            status = .ready
            return
        }
        status = .downloading
        downloadTask = Task { await performDownloads() }
    }

    func cancel() {
        activeDownload?.cancel()
        downloadTask?.cancel()
        downloadTask = nil
        status = .needsDownload
    }

    private func performDownloads() async {
        let fm = FileManager.default

        // Ensure models directory exists
        try? fm.createDirectory(at: Self.modelsDirectory, withIntermediateDirectories: true)

        let toDownload = missingModels
        for model in toDownload {
            if Task.isCancelled { return }
            currentModelName = model.displayName
            currentModelId = model.id
            progressByModel[model.id] = ModelProgress(totalBytes: model.expectedBytes)

            do {
                let tempURL = try await downloadFile(model: model)
                let dest = Self.modelsDirectory.appendingPathComponent(model.filename)
                // Remove existing partial file if any
                try? fm.removeItem(at: dest)
                try fm.moveItem(at: tempURL, to: dest)

                // Verify size
                if let attrs = try? fm.attributesOfItem(atPath: dest.path),
                   let size = attrs[.size] as? Int64,
                   size < model.expectedBytes / 2 {
                    throw DownloadError.fileTooSmall(expected: model.expectedBytes, got: size)
                }

                progressByModel[model.id] = ModelProgress(
                    bytesDownloaded: model.expectedBytes,
                    totalBytes: model.expectedBytes
                )
            } catch is CancellationError {
                return
            } catch {
                status = .failed("Failed to download \(model.displayName): \(error.localizedDescription)")
                return
            }
        }

        currentModelId = nil
        currentModelName = ""
        missingModels = []
        status = .ready
    }

    private func downloadFile(model: ModelDefinition) async throws -> URL {
        // Use main queue as delegate queue so callbacks are on @MainActor
        let session = URLSession(
            configuration: .default,
            delegate: self,
            delegateQueue: OperationQueue.main
        )
        defer { session.finishTasksAndInvalidate() }

        return try await withCheckedThrowingContinuation { continuation in
            self.downloadContinuation = continuation
            let task = session.downloadTask(with: model.remoteURL)
            self.activeDownload = task
            task.resume()
        }
    }

    enum DownloadError: LocalizedError {
        case fileTooSmall(expected: Int64, got: Int64)
        case httpError(Int)

        var errorDescription: String? {
            switch self {
            case .fileTooSmall(let expected, let got):
                return "Downloaded file too small (\(got) bytes, expected ~\(expected))"
            case .httpError(let code):
                return "HTTP error \(code)"
            }
        }
    }
}

// MARK: - URLSessionDownloadDelegate

extension ModelManager: URLSessionDownloadDelegate {

    // Delegate queue is OperationQueue.main, so these run on the main thread.

    nonisolated func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        // Move to a temp file we control (the system deletes `location` after this returns)
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".gguf")
        do {
            try FileManager.default.moveItem(at: location, to: tmp)
            MainActor.assumeIsolated {
                let c = self.downloadContinuation
                self.downloadContinuation = nil
                c?.resume(returning: tmp)
            }
        } catch {
            MainActor.assumeIsolated {
                let c = self.downloadContinuation
                self.downloadContinuation = nil
                c?.resume(throwing: error)
            }
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        MainActor.assumeIsolated {
            guard let modelId = self.currentModelId else { return }
            let total = totalBytesExpectedToWrite > 0
                ? totalBytesExpectedToWrite
                : (Self.models.first { $0.id == modelId }?.expectedBytes ?? 0)
            self.progressByModel[modelId] = ModelProgress(
                bytesDownloaded: totalBytesWritten,
                totalBytes: total
            )
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        guard let error else { return }
        MainActor.assumeIsolated {
            let c = self.downloadContinuation
            self.downloadContinuation = nil
            c?.resume(throwing: error)
        }
    }
}
