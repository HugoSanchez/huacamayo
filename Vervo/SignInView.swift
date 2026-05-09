import AppKit
import SwiftUI

struct SignInView: View {
    @ObservedObject var managedSessionStore: ManagedSessionStore
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 38/255, green: 47/255, blue: 45/255),
                    Color(red: 20/255, green: 22/255, blue: 24/255),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                VStack(spacing: 12) {
                    Text("Vervo")
                        .font(.system(size: 36, weight: .semibold))
                        .foregroundStyle(.white)
                    Text("Sign in to start chatting.")
                        .font(.system(size: 15))
                        .foregroundStyle(.white.opacity(0.6))
                }

                Button(action: signIn) {
                    Text("Sign in to Vervo")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 22)
                        .padding(.vertical, 12)
                        .frame(minWidth: 220)
                        .background(.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .foregroundStyle(Color(red: 1.0, green: 0.55, blue: 0.55))
                        .padding(.horizontal, 24)
                        .multilineTextAlignment(.center)
                }

                Spacer()

                Text("Sign-in opens in your browser and returns to Vervo when finished.")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.35))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 24)
            }
            .padding(.horizontal, 32)
        }
    }

    private func signIn() {
        errorMessage = nil

        let configured = ProcessInfo.processInfo.environment["VERVO_FRONTEND_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = (configured?.isEmpty == false ? configured! : "http://127.0.0.1:3000/login")
        guard let url = URL(string: raw) else {
            errorMessage = "Sign-in URL is not configured."
            return
        }

        NSWorkspace.shared.open(url)
    }
}
