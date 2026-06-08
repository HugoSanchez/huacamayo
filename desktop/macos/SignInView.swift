import AppKit
import SwiftUI

struct SignInView: View {
    @ObservedObject var managedSessionStore: ManagedSessionStore
    @State private var errorMessage: String?

    private static let contentWidth: CGFloat = 300

    var body: some View {
        ZStack {
            Color(red: 243/255, green: 245/255, blue: 247/255)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer()
                centerContent
                Spacer()
            }
        }
    }

    private var header: some View {
        ZStack {
            HStack {
                HStack(spacing: 8) {
                    WindowControlButton(color: Color(red: 1.0, green: 0.38, blue: 0.35), action: .close)
                    WindowControlButton(color: Color(red: 1.0, green: 0.78, blue: 0.24), action: .miniaturize)
                    WindowControlButton(color: Color(red: 0.30, green: 0.85, blue: 0.39), action: .zoom)
                }
                Spacer()
            }
            .padding(.horizontal, 12)

            Text("verso.")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.black.opacity(0.85))
        }
        .frame(height: 38)
        .frame(maxWidth: .infinity)
    }

    private var centerContent: some View {
        VStack(spacing: 32) {
            VStack(spacing: 24) {
               

                VStack(spacing: 16) {
                    (Text("Welcome").font(.system(size: 35, weight: .semibold)))
                        .foregroundStyle(.black.opacity(0.85))

                    Text("Please sign in by clicking the button bellow. You will be redirected back to verso once done.")
                        .font(.system(size: 13))
                        .foregroundStyle(.black.opacity(0.55))
                        .multilineTextAlignment(.center)
                        .lineSpacing(2)
                        .frame(width: Self.contentWidth)
                }
            }

            Button(action: signIn) {
                Text("Sign in")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(.black, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .frame(width: Self.contentWidth)

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(red: 192/255, green: 57/255, blue: 43/255))
                    .multilineTextAlignment(.center)
                    .frame(width: Self.contentWidth)
            }
        }
    }

    private func signIn() {
        errorMessage = nil

        let configured = ProcessInfo.processInfo.environment["VERSO_FRONTEND_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = (configured?.isEmpty == false ? configured! : Self.defaultFrontendURL)
        guard let url = Self.freshPrivySessionURL(from: raw) else {
            errorMessage = "Sign-in URL is not configured."
            return
        }

        NSWorkspace.shared.open(url)
    }

    /// Debug builds (Xcode → Run) use localhost so day-to-day dev still works.
    /// Release builds (Archive) point at the deployed frontend so friends sign
    /// in via the real domain. The `VERSO_FRONTEND_URL` env var still wins if
    /// set, useful for testing prod from a debug build or vice versa.
    private static var defaultFrontendURL: String {
        #if DEBUG
        return "http://127.0.0.1:3000/login"
        #else
        return "https://www.itsverso.xyz/login"
        #endif
    }

    private static func freshPrivySessionURL(from raw: String) -> URL? {
        guard var components = URLComponents(string: raw) else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "fresh_privy_session" }
        queryItems.removeAll { $0.name == "redirect_uri" }
        queryItems.append(URLQueryItem(name: "fresh_privy_session", value: "1"))
        queryItems.append(URLQueryItem(name: "redirect_uri", value: Self.callbackRedirectURI))
        components.queryItems = queryItems
        return components.url
    }

    private static var callbackRedirectURI: String {
        #if DEBUG
        return "verso-dev://auth/callback"
        #else
        return "verso://auth/callback"
        #endif
    }
}
