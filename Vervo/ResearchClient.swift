import Foundation

/// Thin HTTP client for the research-core sidecar API.
/// All methods throw on network errors or non-2xx responses.
@MainActor
final class ResearchClient: ObservableObject {
    private let sidecar: SidecarManager

    init(sidecar: SidecarManager) {
        self.sidecar = sidecar
    }

    private var baseURL: URL {
        get throws {
            guard let url = sidecar.baseURL else {
                throw ResearchClientError.sidecarNotRunning
            }
            return url
        }
    }

    // MARK: - Health

    func health() async throws -> [String: Any] {
        try await get("/health")
    }

    // MARK: - Pages

    func getPage(slug: String) async throws -> [String: Any]? {
        do {
            return try await get("/pages/\(slug)")
        } catch ResearchClientError.notFound {
            return nil
        }
    }

    func listPages(type: String? = nil, limit: Int? = nil) async throws -> [[String: Any]] {
        var query: [String] = []
        if let type { query.append("type=\(type)") }
        if let limit { query.append("limit=\(limit)") }
        let path = query.isEmpty ? "/pages" : "/pages?\(query.joined(separator: "&"))"
        return try await get(path)
    }

    func putPage(slug: String, body: [String: Any]) async throws -> [String: Any] {
        try await request("PUT", path: "/pages/\(slug)", body: body)
    }

    func deletePage(slug: String) async throws {
        let _: [String: Any] = try await request("DELETE", path: "/pages/\(slug)")
    }

    // MARK: - Sources

    func createSource(_ body: [String: Any]) async throws -> [String: Any] {
        try await request("POST", path: "/sources", body: body)
    }

    func getSource(id: String) async throws -> [String: Any]? {
        do {
            return try await get("/sources/\(id)")
        } catch ResearchClientError.notFound {
            return nil
        }
    }

    func listSources() async throws -> [[String: Any]] {
        try await get("/sources")
    }

    func deleteSource(id: String) async throws {
        let _: [String: Any] = try await request("DELETE", path: "/sources/\(id)")
    }

    func updateSourceStatus(id: String, status: String) async throws {
        let _: [String: Any] = try await request("PATCH", path: "/sources/\(id)/status", body: ["status": status])
    }

    // MARK: - Contexts

    func createContext(_ body: [String: Any]) async throws -> [String: Any] {
        try await request("POST", path: "/contexts", body: body)
    }

    func getContext(id: String) async throws -> [String: Any]? {
        do {
            return try await get("/contexts/\(id)")
        } catch ResearchClientError.notFound {
            return nil
        }
    }

    func listContexts() async throws -> [[String: Any]] {
        try await get("/contexts")
    }

    func deleteContext(id: String) async throws {
        let _: [String: Any] = try await request("DELETE", path: "/contexts/\(id)")
    }

    func addSourceToContext(contextId: String, sourceId: String) async throws {
        let _: [String: Any] = try await request("POST", path: "/contexts/\(contextId)/sources", body: ["sourceId": sourceId])
    }

    func removeSourceFromContext(contextId: String, sourceId: String) async throws {
        let _: [String: Any] = try await request("DELETE", path: "/contexts/\(contextId)/sources/\(sourceId)")
    }

    // MARK: - Search

    func search(query: String, contextId: String? = nil, limit: Int? = nil, rerank: Bool? = nil) async throws -> [[String: Any]] {
        var body: [String: Any] = ["query": query]
        if let contextId { body["contextId"] = contextId }
        if let limit { body["limit"] = limit }
        if let rerank { body["rerank"] = rerank }
        return try await request("POST", path: "/search", body: body)
    }

    // MARK: - Import

    func importContent(slug: String, content: String, sourceId: String? = nil) async throws -> [String: Any] {
        var body: [String: Any] = ["slug": slug, "content": content]
        if let sourceId { body["sourceId"] = sourceId }
        return try await request("POST", path: "/import", body: body)
    }

    // MARK: - Tags

    func listAllTags() async throws -> [String] {
        try await get("/tags")
    }

    func getTags(slug: String) async throws -> [String] {
        try await get("/pages/\(slug)/tags")
    }

    func addTag(slug: String, tag: String) async throws {
        let _: [String: Any] = try await request("POST", path: "/pages/\(slug)/tags", body: ["tag": tag])
    }

    // MARK: - Graph

    func getGraph(slug: String, depth: Int = 5) async throws -> [String: Any] {
        try await get("/graph/\(slug)?depth=\(depth)")
    }

    // MARK: - Stats

    func getStats() async throws -> [String: Any] {
        try await get("/stats")
    }

    // MARK: - Embedding Status

    func embeddingStatus() async throws -> [String: Any] {
        try await get("/embedding/status")
    }

    // MARK: - Private

    private func get<T>(_ path: String) async throws -> T {
        try await request("GET", path: path)
    }

    private func request<T>(_ method: String, path: String, body: [String: Any]? = nil) async throws -> T {
        let url = try baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30

        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: req)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ResearchClientError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200, 201:
            let parsed = try JSONSerialization.jsonObject(with: data)
            guard let result = parsed as? T else {
                throw ResearchClientError.unexpectedResponseType
            }
            return result
        case 404:
            throw ResearchClientError.notFound
        default:
            let body = String(data: data, encoding: .utf8) ?? ""
            throw ResearchClientError.httpError(httpResponse.statusCode, body)
        }
    }
}

enum ResearchClientError: LocalizedError {
    case sidecarNotRunning
    case invalidResponse
    case unexpectedResponseType
    case notFound
    case httpError(Int, String)

    var errorDescription: String? {
        switch self {
        case .sidecarNotRunning: return "Research sidecar is not running"
        case .invalidResponse: return "Invalid response from sidecar"
        case .unexpectedResponseType: return "Unexpected response type"
        case .notFound: return "Resource not found"
        case .httpError(let code, let body): return "HTTP \(code): \(body)"
        }
    }
}
