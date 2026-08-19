import XCTest

final class SidecarLaunchEnvironmentTests: XCTestCase {
    func testLaunchEnvironmentSetsAuthParentAndProductBackend() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: ["PATH": "/custom/bin"],
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "sidecar-secret",
            parentProcessIdentifier: 1234
        )

        XCTAssertEqual(environment["VERSO_BACKEND_URL"], SidecarLaunchEnvironment.defaultBackendURL)
        XCTAssertEqual(environment["VERSO_SIDECAR_AUTH_SECRET"], "sidecar-secret")
        XCTAssertEqual(environment["VERSO_PARENT_PID"], "1234")
        XCTAssertEqual(
            environment["PATH"],
            "/Users/tester/.local/bin:/Users/tester/.hermes/hermes-agent/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/custom/bin"
        )
    }

    func testExplicitBackendIsPreserved() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: ["VERSO_BACKEND_URL": "https://local.example"],
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(environment["VERSO_BACKEND_URL"], "https://local.example")
    }

    func testManagedSessionSeedReplacesInheritedIdentity() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [
                "VERSO_MANAGED_SESSION_TOKEN": "old-token",
                "VERSO_MANAGED_SESSION_EXPIRES_AT": "old-expiration",
                "VERSO_MANAGED_USER_ID": "old-user",
            ],
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: SidecarManagedSessionSeed(
                token: "new-token",
                expiresAt: "2027-01-01T00:00:00Z",
                userId: "new-user"
            ),
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(environment["VERSO_MANAGED_SESSION_TOKEN"], "new-token")
        XCTAssertEqual(environment["VERSO_MANAGED_SESSION_EXPIRES_AT"], "2027-01-01T00:00:00Z")
        XCTAssertEqual(environment["VERSO_MANAGED_USER_ID"], "new-user")
    }

    func testMissingSessionRemovesInheritedManagedIdentity() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [
                "VERSO_MANAGED_SESSION_TOKEN": "stale-token",
                "VERSO_MANAGED_SESSION_EXPIRES_AT": "stale-expiration",
                "VERSO_MANAGED_USER_ID": "stale-user",
            ],
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertNil(environment["VERSO_MANAGED_SESSION_TOKEN"])
        XCTAssertNil(environment["VERSO_MANAGED_SESSION_EXPIRES_AT"])
        XCTAssertNil(environment["VERSO_MANAGED_USER_ID"])
    }
}
