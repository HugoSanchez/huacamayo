import Foundation
import XCTest

final class SidebarAPIClientTests: XCTestCase {
    func testFetchSessionsUsesAuthenticatedTypedRequest() async throws {
        let transport = SidebarStubTransport { request in
            XCTAssertEqual(request.url?.path, "/chat/sessions")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Verso-Sidecar-Token"), "secret")
            return try Self.response(
                for: request,
                body: #"{"sessions":[{"id":"one","title":"First","createdAt":"2026-08-19T10:00:00Z","updatedAt":"2026-08-19T10:00:00Z","archivedAt":null,"model":"gpt-5","messageCount":2,"lastMessagePreview":"Hello"}]}"#
            )
        }
        let client = SidebarAPIClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "secret",
            transport: transport
        )

        let sessions = try await client.fetchSessions()

        XCTAssertEqual(sessions.map(\.id), ["one"])
        XCTAssertEqual(sessions.first?.messageCount, 2)
    }

    func testRenameSessionSendsJSONAndDecodesCanonicalSession() async throws {
        let transport = SidebarStubTransport { request in
            XCTAssertEqual(request.url?.path, "/chat/sessions/one/rename")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try XCTUnwrap(request.httpBody)
            XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["title": "Renamed"])
            return try Self.response(
                for: request,
                body: #"{"session":{"id":"one","title":"Renamed","createdAt":"2026-08-19T10:00:00Z","updatedAt":"2026-08-19T10:01:00Z","archivedAt":null,"model":null,"messageCount":0,"lastMessagePreview":null}}"#
            )
        }
        let client = SidebarAPIClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "secret",
            transport: transport
        )

        let session = try await client.renameSession(id: "one", title: "Renamed")

        XCTAssertEqual(session.title, "Renamed")
    }

    func testCustomConnectorLogoPathResolvesAgainstSidecar() async throws {
        let transport = SidebarStubTransport { request in
            try Self.response(
                for: request,
                body: #"{"connectors":[{"id":"notion","name":"Notion","slug":"notion","url":"https://example.com","transport":"sse","auth":"oauth","logoUrl":"/logos/notion.png","status":{"state":"connected","toolCount":3,"reason":null,"cached":false}}]}"#
            )
        }
        let client = SidebarAPIClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "secret",
            transport: transport
        )

        let connectors = try await client.fetchCustomConnectors()

        XCTAssertEqual(connectors.first?.logoUrl, "http://127.0.0.1:4242/logos/notion.png")
    }

    private static func response(
        for request: URLRequest,
        statusCode: Int = 200,
        body: String
    ) throws -> (Data, URLResponse) {
        let response = try XCTUnwrap(
            HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            )
        )
        return (Data(body.utf8), response)
    }
}

private final class SidebarStubTransport: SidecarHTTPTransport {
    private let handler: (URLRequest) throws -> (Data, URLResponse)

    init(handler: @escaping (URLRequest) throws -> (Data, URLResponse)) {
        self.handler = handler
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try handler(request)
    }
}
