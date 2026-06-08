import Foundation
import Security
import SwiftUI

struct ManagedAppSession: Codable, Equatable {
    let token: String
    let expiresAt: String
    let userId: String
    let email: String?
    let displayName: String?
    let receivedAt: String

    var identityLabel: String {
        if let email, !email.isEmpty { return email }
        if let displayName, !displayName.isEmpty { return displayName }
        return userId
    }

    var isExpired: Bool {
        guard let date = Self.iso8601.date(from: expiresAt) ?? Self.iso8601Fractional.date(from: expiresAt) else {
            return false
        }
        return date <= Date()
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct ManagedSessionEvent: Equatable {
    let id: UUID
    let message: String
    let isError: Bool
}

@MainActor
final class ManagedSessionStore: ObservableObject {
    private static let keychainService = "com.verso.managed-session"
    private static let keychainAccount = "current"
    private static let supportedCallbackSchemes: Set<String> = ["verso", "verso-dev"]

    @Published private(set) var currentSession: ManagedAppSession?
    @Published private(set) var latestEvent: ManagedSessionEvent?

    init() {
        self.currentSession = Self.loadFromKeychain()
        if currentSession?.isExpired == true {
            clearSession(notify: false)
        }
    }

    func handleCallbackURL(_ url: URL) {
        guard Self.supportedCallbackSchemes.contains(url.scheme?.lowercased() ?? "") else { return }
        guard url.host?.lowercased() == "auth", url.path == "/callback" else {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Ignored unsupported auth callback URL.", isError: true)
            return
        }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItemValue(named: "session_token"),
              let expiresAt = components.queryItemValue(named: "expires_at"),
              let userId = components.queryItemValue(named: "user_id") else {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Auth callback is missing required session parameters.", isError: true)
            return
        }

        let session = ManagedAppSession(
            token: token,
            expiresAt: expiresAt,
            userId: userId,
            email: components.queryItemValue(named: "email"),
            displayName: components.queryItemValue(named: "display_name"),
            receivedAt: Self.timestamp()
        )

        currentSession = session
        persist(session)
        latestEvent = ManagedSessionEvent(id: UUID(), message: "Signed in as \(session.identityLabel).", isError: false)
    }

    func clearSession(notify: Bool = true) {
        currentSession = nil
        Self.deleteFromKeychain()
        if notify {
            latestEvent = ManagedSessionEvent(id: UUID(), message: "Signed out.", isError: false)
        }
    }

    private func persist(_ session: ManagedAppSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        Self.writeToKeychain(data: data)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
    }

    private static func loadFromKeychain() -> ManagedAppSession? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(ManagedAppSession.self, from: data)
    }

    private static func writeToKeychain(data: Data) {
        let query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    private static func deleteFromKeychain() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

private extension URLComponents {
    func queryItemValue(named name: String) -> String? {
        queryItems?.first(where: { $0.name == name })?.value
    }
}
