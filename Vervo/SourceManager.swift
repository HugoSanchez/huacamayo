import Foundation
import AppKit
import PDFKit
import os

/// Manages sources: add folders, scan for files, import via the sidecar API.
@MainActor
final class SourceManager: ObservableObject {
    struct Source: Identifiable {
        let id: String
        let name: String
        let location: String
        var status: String
        var fileCount: Int
    }

    @Published var sources: [Source] = []
    @Published var scanningSourceId: String?

    private let client: ResearchClient
    private let logger = Logger(subsystem: "com.vervo.app", category: "Sources")

    private static let supportedExtensions: Set<String> = ["md", "markdown", "txt", "text", "pdf"]

    init(client: ResearchClient) {
        self.client = client
    }

    /// Load sources from the sidecar.
    func refresh() async {
        do {
            let list = try await client.listSources()
            sources = list.map { dict in
                Source(
                    id: dict["id"] as? String ?? "",
                    name: dict["name"] as? String ?? "Unknown",
                    location: dict["location"] as? String ?? "",
                    status: dict["status"] as? String ?? "unknown",
                    fileCount: 0
                )
            }
        } catch {
            logger.error("Failed to refresh sources: \(error.localizedDescription)")
        }
    }

    /// Open a folder picker and add the selected folder as a source.
    func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder to add as a research source"
        panel.prompt = "Add Source"

        guard panel.runModal() == .OK, let url = panel.url else { return }

        Task {
            await addSource(at: url)
        }
    }

    /// Add a folder URL as a source, then scan and import its files.
    func addSource(at url: URL) async {
        let name = url.lastPathComponent
        let location = url.path

        // Check for duplicate
        if sources.contains(where: { $0.location == location }) {
            logger.info("Source already exists: \(location)")
            return
        }

        do {
            let result = try await client.createSource([
                "name": name,
                "location": location,
                "type": "folder",
            ])

            let sourceId = result["id"] as? String ?? ""
            let source = Source(id: sourceId, name: name, location: location, status: "scanning", fileCount: 0)
            sources.append(source)

            await scanAndImport(source: source)
        } catch {
            logger.error("Failed to create source: \(error.localizedDescription)")
        }
    }

    /// Remove a source and its association (pages remain but lose source_id).
    func removeSource(id: String) async {
        do {
            try await client.deleteSource(id: id)
            sources.removeAll { $0.id == id }
        } catch {
            logger.error("Failed to delete source \(id): \(error.localizedDescription)")
        }
    }

    // MARK: - Private

    private func scanAndImport(source: Source) async {
        scanningSourceId = source.id
        defer { scanningSourceId = nil }

        let files = discoverFiles(at: URL(fileURLWithPath: source.location))
        logger.info("Found \(files.count) files in \(source.name)")

        var imported = 0
        for fileURL in files {
            do {
                let content = try readFileContent(at: fileURL)
                guard !content.isEmpty else {
                    logger.warning("Skipping empty file: \(fileURL.lastPathComponent)")
                    continue
                }
                let slug = slugFor(fileURL: fileURL, sourceLocation: source.location)
                _ = try await client.importContent(slug: slug, content: content, sourceId: source.id)
                imported += 1
            } catch {
                logger.warning("Failed to import \(fileURL.lastPathComponent): \(error.localizedDescription)")
            }
        }

        // Update local state
        if let idx = sources.firstIndex(where: { $0.id == source.id }) {
            sources[idx].status = "ready"
            sources[idx].fileCount = imported
        }

        // Update status on the sidecar
        do {
            try await client.updateSourceStatus(id: source.id, status: "ready")
        } catch {
            logger.warning("Failed to update source status: \(error.localizedDescription)")
        }

        logger.info("Imported \(imported)/\(files.count) files from \(source.name)")
    }

    /// Read file content, extracting text from PDFs via PDFKit.
    private func readFileContent(at url: URL) throws -> String {
        let ext = url.pathExtension.lowercased()
        if ext == "pdf" {
            guard let doc = PDFDocument(url: url) else {
                throw NSError(domain: "SourceManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not open PDF"])
            }
            var pages: [String] = []
            for i in 0..<doc.pageCount {
                if let page = doc.page(at: i), let text = page.string {
                    pages.append(text)
                }
            }
            let title = url.deletingPathExtension().lastPathComponent
            return "---\ntitle: \(title)\ntype: reference\n---\n\n" + pages.joined(separator: "\n\n")
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func discoverFiles(at root: URL) -> [URL] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var results: [URL] = []
        for case let fileURL as URL in enumerator {
            let ext = fileURL.pathExtension.lowercased()
            if Self.supportedExtensions.contains(ext) {
                results.append(fileURL)
            }
        }
        return results.sorted { $0.path < $1.path }
    }

    /// Convert a file path into a page slug relative to the source.
    private func slugFor(fileURL: URL, sourceLocation: String) -> String {
        var relative = fileURL.path
        if relative.hasPrefix(sourceLocation) {
            relative = String(relative.dropFirst(sourceLocation.count))
            if relative.hasPrefix("/") { relative = String(relative.dropFirst()) }
        }
        // Strip extension and normalize
        if let dotIdx = relative.lastIndex(of: ".") {
            relative = String(relative[..<dotIdx])
        }
        // Replace spaces with hyphens, lowercase
        return relative
            .replacingOccurrences(of: " ", with: "-")
            .lowercased()
    }
}

