import Foundation

struct SidecarManagedSessionSeed: Equatable {
    let token: String
    let expiresAt: String
    let userId: String
}

struct SidecarLaunchEnvironment {
    static let defaultBackendURL = "https://verso-backend-2lg3.onrender.com"

    static func make(
        baseEnvironment: [String: String],
        homeDirectory: String,
        bundleRoot: String?,
        hermesHomeOverride: String?,
        managedSession: SidecarManagedSessionSeed?,
        authToken: String,
        parentProcessIdentifier: Int32
    ) -> [String: String] {
        var environment = baseEnvironment
        let extraPaths = [
            "\(homeDirectory)/.local/bin",
            "\(homeDirectory)/.hermes/hermes-agent/venv/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
        ]
        let currentPath = environment["PATH"] ?? ""
        environment["PATH"] = (extraPaths + [currentPath]).joined(separator: ":")

        // Debug and Conductor launches are product-testing paths too. Only an
        // explicit scheme environment should replace the deployed backend.
        if environment["VERSO_BACKEND_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true {
            environment["VERSO_BACKEND_URL"] = defaultBackendURL
        }

        SidecarRuntimeResolver.applyBundledRuntimeEnvironment(
            &environment,
            bundleRoot: bundleRoot,
            homeDirectory: homeDirectory,
            hermesHomeOverride: hermesHomeOverride
        )

        if let managedSession {
            environment["VERSO_MANAGED_SESSION_TOKEN"] = managedSession.token
            environment["VERSO_MANAGED_SESSION_EXPIRES_AT"] = managedSession.expiresAt
            environment["VERSO_MANAGED_USER_ID"] = managedSession.userId
        } else {
            // Never allow a stale shell/Xcode identity to leak into a launch
            // that intentionally has no active managed session.
            environment.removeValue(forKey: "VERSO_MANAGED_SESSION_TOKEN")
            environment.removeValue(forKey: "VERSO_MANAGED_SESSION_EXPIRES_AT")
            environment.removeValue(forKey: "VERSO_MANAGED_USER_ID")
        }

        environment["VERSO_SIDECAR_AUTH_SECRET"] = authToken
        // The orchestrator self-exits if the native parent crashes or is
        // force-quit, preventing a re-parented sidecar from living forever.
        environment["VERSO_PARENT_PID"] = String(parentProcessIdentifier)
        return environment
    }
}
