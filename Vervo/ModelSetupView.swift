import SwiftUI

/// Minimal first-run view — auto-starts downloading, native spinner + subtle text.
struct ModelSetupView: View {
    @ObservedObject var modelManager: ModelManager
    @AppStorage("isDarkMode") private var isDarkMode = true

    private var bg: Color {
        isDarkMode
            ? Color(red: 20/255, green: 22/255, blue: 24/255)
            : Color(red: 243/255, green: 245/255, blue: 247/255)
    }

    private var textColor: Color {
        isDarkMode ? Color.white.opacity(0.35) : Color.black.opacity(0.30)
    }

    private var border: Color {
        isDarkMode ? Color.white.opacity(0.08) : Color.black.opacity(0.10)
    }

    var body: some View {
        ZStack {
            bg.ignoresSafeArea()

            VStack(spacing: 14) {
                ProgressView()
                    .controlSize(.small)

                Text("Setting up Vervo")
                    .font(.system(size: 13))
                    .foregroundStyle(textColor)

                Text("This might take a few minutes, please hold on")
                    .font(.system(size: 11))
                    .foregroundStyle(textColor.opacity(0.6))

                if case .failed(let message) = modelManager.status {
                    Text(message)
                        .font(.system(size: 11))
                        .foregroundStyle(.red.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)

                    Button("Retry") { modelManager.downloadMissing() }
                        .buttonStyle(.plain)
                        .font(.system(size: 11))
                        .foregroundStyle(textColor)
                }
            }
        }
        .preferredColorScheme(isDarkMode ? .dark : .light)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(border, lineWidth: 1)
        }
        .onAppear {
            if modelManager.status == .needsDownload {
                modelManager.downloadMissing()
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Setting up") {
    let mm = ModelManager()
    mm.checkModels(forceNeedsDownload: true)
    mm.status = .downloading
    return ModelSetupView(modelManager: mm)
        .frame(width: 600, height: 400)
}

#Preview("Failed") {
    let mm = ModelManager()
    mm.checkModels(forceNeedsDownload: true)
    mm.status = .failed("Network connection lost")
    return ModelSetupView(modelManager: mm)
        .frame(width: 600, height: 400)
}
#endif
