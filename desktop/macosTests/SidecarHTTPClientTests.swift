import Foundation
import XCTest

final class SidecarHTTPClientTests: XCTestCase {
    func testFetchManagedAccountAuthenticatesAndDecodesResponse() async throws {
        let transport = StubSidecarHTTPTransport { request in
            XCTAssertEqual(request.url?.path, "/managed/account")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Verso-Sidecar-Token"), "secret")
            return try Self.response(
                for: request,
                statusCode: 200,
                body: """
                {
                  "backend": {"configured": true, "baseUrl": null},
                  "session": {
                    "present": true,
                    "userId": "user-1",
                    "email": null,
                    "displayName": null,
                    "expiresAt": null,
                    "receivedAt": null,
                    "expired": false
                  },
                  "account": {
                    "state": "ready",
                    "error": null,
                    "user": null,
                    "device": null,
                    "session": null,
                    "entitlements": []
                  }
                }
                """
            )
        }
        let client = SidecarHTTPClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "secret",
            transport: transport
        )

        let account = try await client.fetchManagedAccount()

        XCTAssertEqual(account.account.state, "ready")
        XCTAssertEqual(account.session.userId, "user-1")
    }

    func testSetManagedSessionUsesAuthenticatedJSONPost() async throws {
        let transport = StubSidecarHTTPTransport { request in
            XCTAssertEqual(request.url?.path, "/managed/session")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Verso-Sidecar-Token"), "secret")
            XCTAssertEqual(
                try JSONDecoder().decode(SessionFixture.self, from: XCTUnwrap(request.httpBody)),
                SessionFixture(userId: "user-1")
            )
            return try Self.response(for: request, statusCode: 204)
        }
        let client = SidecarHTTPClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "secret",
            transport: transport
        )

        try await client.setManagedSession(SessionFixture(userId: "user-1"))
    }

    func testClearManagedSessionUsesAuthenticatedDelete() async throws {
        let transport = StubSidecarHTTPTransport { request in
            XCTAssertEqual(request.url?.path, "/managed/session")
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Verso-Sidecar-Token"), "secret")
            return try Self.response(for: request, statusCode: 204)
        }
        let client = SidecarHTTPClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "secret",
            transport: transport
        )

        try await client.clearManagedSession()
    }

    func testNonSuccessStatusIsReported() async throws {
        let transport = StubSidecarHTTPTransport { request in
            try Self.response(for: request, statusCode: 401)
        }
        let client = SidecarHTTPClient(
            baseURL: URL(string: "http://127.0.0.1:4242")!,
            authToken: "stale-secret",
            transport: transport
        )

        do {
            try await client.clearManagedSession()
            XCTFail("Expected an HTTP status error")
        } catch {
            XCTAssertEqual(error as? SidecarHTTPError, .httpStatus(401))
        }
    }

    private static func response(
        for request: URLRequest,
        statusCode: Int,
        body: String = ""
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

private struct SessionFixture: Codable, Equatable {
    let userId: String
}

private final class StubSidecarHTTPTransport: SidecarHTTPTransport {
    private let handler: (URLRequest) throws -> (Data, URLResponse)

    init(handler: @escaping (URLRequest) throws -> (Data, URLResponse)) {
        self.handler = handler
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try handler(request)
    }
}
