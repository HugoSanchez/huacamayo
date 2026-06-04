import AppKit
import Combine
import Sparkle
import SwiftUI

@MainActor
final class VersoUpdateUserDriver: NSObject, SPUUserDriver, ObservableObject {
    @Published fileprivate var activeToast: VersoUpdateToastState?

    private var dismissTimer: Timer?
    private var expectedContentLength: UInt64 = 0
    private var receivedContentLength: UInt64 = 0
    private var downloadCancellation: (() -> Void)?

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, automaticUpdateDownloading: NSNumber(value: false), sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        showToast(
            VersoUpdateToastState(
                title: "Checking for updates",
                message: "Looking for the latest version of Verso.",
                progress: nil,
                showsActivity: true,
                primaryTitle: nil,
                primaryAction: nil,
                secondaryTitle: "Cancel",
                secondaryAction: { [weak self] in
                    cancellation()
                    self?.dismissToast()
                },
                closeAction: { [weak self] in
                    cancellation()
                    self?.dismissToast()
                }
            )
        )
    }

    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        let replyOnce = makeSingleReply(reply)
        let version = appcastItem.displayVersionString

        if appcastItem.isInformationOnlyUpdate {
            showToast(
                VersoUpdateToastState(
                    title: "Verso \(version) is available",
                    message: "Open the release page to learn more about this update.",
                    progress: nil,
                    showsActivity: false,
                    primaryTitle: "Open Release",
                    primaryAction: { [weak self] in
                        if let infoURL = appcastItem.infoURL {
                            NSWorkspace.shared.open(infoURL)
                        }
                        replyOnce(.dismiss)
                        self?.dismissToast()
                    },
                    secondaryTitle: "Later",
                    secondaryAction: { [weak self] in
                        replyOnce(.dismiss)
                        self?.dismissToast()
                    },
                    closeAction: { [weak self] in
                        replyOnce(.dismiss)
                        self?.dismissToast()
                    }
                )
            )
            return
        }

        let title: String
        let message: String
        let primaryTitle: String

        switch state.stage {
        case .downloaded:
            title = "New update available"
            message = ""
            primaryTitle = "Restart"
        case .installing:
            title = "New update available"
            message = ""
            primaryTitle = "Restart"
        default:
            title = "New update available"
            message = ""
            primaryTitle = "Install Update"
        }

        let secondaryTitle = appcastItem.infoURL == nil ? "Later" : "See Changes"

        showToast(
            VersoUpdateToastState(
                title: title,
                message: message,
                progress: nil,
                showsActivity: false,
                primaryTitle: primaryTitle,
                primaryAction: { [weak self] in
                    replyOnce(.install)
                    self?.showDownloadToast()
                },
                secondaryTitle: secondaryTitle,
                secondaryAction: { [weak self] in
                    if let infoURL = appcastItem.infoURL {
                        NSWorkspace.shared.open(infoURL)
                    }
                    replyOnce(.dismiss)
                    self?.dismissToast()
                },
                closeAction: { [weak self] in
                    replyOnce(.dismiss)
                    self?.dismissToast()
                }
            )
        )
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        // The compact toast intentionally keeps release notes out of the first prompt.
    }

    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
        // Release notes are secondary to the update action, so this is silent.
    }

    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        showToast(
            VersoUpdateToastState(
                title: "Verso is up to date",
                message: "You already have the latest available version.",
                progress: nil,
                showsActivity: false,
                primaryTitle: "Done",
                primaryAction: { [weak self] in
                    acknowledgement()
                    self?.dismissToast()
                },
                secondaryTitle: nil,
                secondaryAction: nil,
                closeAction: { [weak self] in
                    acknowledgement()
                    self?.dismissToast()
                }
            ),
            autoDismissAfter: 3.0,
            onAutoDismiss: acknowledgement
        )
    }

    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        showToast(
            VersoUpdateToastState(
                title: "Update failed",
                message: error.localizedDescription,
                progress: nil,
                showsActivity: false,
                primaryTitle: "Done",
                primaryAction: { [weak self] in
                    acknowledgement()
                    self?.dismissToast()
                },
                secondaryTitle: nil,
                secondaryAction: nil,
                closeAction: { [weak self] in
                    acknowledgement()
                    self?.dismissToast()
                }
            )
        )
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        expectedContentLength = 0
        receivedContentLength = 0
        downloadCancellation = cancellation
        showDownloadToast(cancellation: cancellation)
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        self.expectedContentLength = expectedContentLength
        showDownloadToast()
    }

    func showDownloadDidReceiveData(ofLength length: UInt64) {
        receivedContentLength += length
        showDownloadToast()
    }

    func showDownloadDidStartExtractingUpdate() {
        downloadCancellation = nil
        showToast(
            VersoUpdateToastState(
                title: "Preparing update",
                message: "Verso is verifying and unpacking the download.",
                progress: nil,
                showsActivity: true,
                primaryTitle: nil,
                primaryAction: nil,
                secondaryTitle: nil,
                secondaryAction: nil,
                closeAction: nil
            )
        )
    }

    func showExtractionReceivedProgress(_ progress: Double) {
        showToast(
            VersoUpdateToastState(
                title: "Preparing update",
                message: "Verso is verifying and unpacking the download.",
                progress: min(max(progress, 0), 1),
                showsActivity: false,
                primaryTitle: nil,
                primaryAction: nil,
                secondaryTitle: nil,
                secondaryAction: nil,
                closeAction: nil
            )
        )
    }

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        downloadCancellation = nil
        let replyOnce = makeSingleReply(reply)
        showInstallingToast(applicationTerminated: false, retryTerminatingApplication: nil)
        DispatchQueue.main.async {
            replyOnce(.install)
        }
    }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        downloadCancellation = nil
        showInstallingToast(applicationTerminated: applicationTerminated, retryTerminatingApplication: retryTerminatingApplication)
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        showToast(
            VersoUpdateToastState(
                title: relaunched ? "Update installed" : "Update complete",
                message: relaunched ? "Verso has relaunched with the latest version." : "The update was installed.",
                progress: nil,
                showsActivity: false,
                primaryTitle: "Done",
                primaryAction: { [weak self] in
                    acknowledgement()
                    self?.dismissToast()
                },
                secondaryTitle: nil,
                secondaryAction: nil,
                closeAction: { [weak self] in
                    acknowledgement()
                    self?.dismissToast()
                }
            ),
            autoDismissAfter: 3.0,
            onAutoDismiss: acknowledgement
        )
    }

    func dismissUpdateInstallation() {
        downloadCancellation = nil
        dismissToast()
    }

    func showUpdateInFocus() {
        NotificationCenter.default.post(name: .versoRestoreKeyboardFocus, object: self)
    }

    private func showDownloadToast(cancellation: (() -> Void)? = nil) {
        let cancellationAction = cancellation ?? downloadCancellation
        let progress: Double
        if expectedContentLength > 0 {
            progress = min(Double(receivedContentLength) / Double(expectedContentLength), 1)
        } else {
            progress = 0
        }

        showToast(
            VersoUpdateToastState(
                title: "Downloading update",
                message: "Verso is downloading the latest version.",
                progress: progress,
                showsActivity: false,
                primaryTitle: nil,
                primaryAction: nil,
                secondaryTitle: cancellationAction == nil ? nil : "Cancel",
                secondaryAction: { [weak self] in
                    cancellationAction?()
                    self?.downloadCancellation = nil
                    self?.dismissToast()
                },
                closeAction: nil
            )
        )
    }

    private func showInstallingToast(applicationTerminated: Bool, retryTerminatingApplication: (() -> Void)?) {
        showToast(
            VersoUpdateToastState(
                title: applicationTerminated ? "Installing update" : "Restarting Verso",
                message: applicationTerminated ? "The update is being installed." : "Verso needs to quit before the update can finish.",
                progress: nil,
                showsActivity: true,
                primaryTitle: applicationTerminated || retryTerminatingApplication == nil ? nil : "Retry Quit",
                primaryAction: retryTerminatingApplication,
                secondaryTitle: nil,
                secondaryAction: nil,
                closeAction: nil
            )
        )
    }

    private func showToast(_ state: VersoUpdateToastState, autoDismissAfter delay: TimeInterval? = nil, onAutoDismiss: (() -> Void)? = nil) {
        dismissTimer?.invalidate()
        dismissTimer = nil
        activeToast = state

        if let delay {
            dismissTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    onAutoDismiss?()
                    self?.dismissToast()
                }
            }
        }
    }

    private func dismissToast() {
        dismissTimer?.invalidate()
        dismissTimer = nil
        activeToast = nil
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .versoRestoreKeyboardFocus, object: self)
        }
    }

    private func makeSingleReply(_ reply: @escaping (SPUUserUpdateChoice) -> Void) -> (SPUUserUpdateChoice) -> Void {
        var didReply = false
        return { choice in
            guard !didReply else { return }
            didReply = true
            reply(choice)
        }
    }
}

struct VersoUpdateToastOverlay: View {
    @ObservedObject var driver: VersoUpdateUserDriver

    var body: some View {
        if let state = driver.activeToast {
            VersoUpdateToastView(state: state)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .zIndex(1)
        }
    }
}

private struct VersoUpdateToastState {
    let title: String
    let message: String
    let progress: Double?
    let showsActivity: Bool
    let primaryTitle: String?
    let primaryAction: (() -> Void)?
    let secondaryTitle: String?
    let secondaryAction: (() -> Void)?
    let closeAction: (() -> Void)?
}

private struct VersoUpdateToastView: View {
    static let cardWidth: CGFloat = 360
    static let width: CGFloat = cardWidth

    static func height(for state: VersoUpdateToastState) -> CGFloat {
        cardHeight(for: state)
    }

    private static func cardHeight(for state: VersoUpdateToastState) -> CGFloat {
        if state.progress != nil || state.showsActivity {
            if hasActions(state) {
                return state.message.isEmpty ? 138 : 154
            }

            if state.showsActivity && state.closeAction == nil {
                return 78
            }

            if state.progress == nil {
                return state.message.isEmpty ? 72 : 90
            }

            return state.message.isEmpty ? 110 : 126
        }

        if hasActions(state) {
            return state.message.isEmpty ? 104 : 118
        }

        return state.message.isEmpty ? 72 : 90
    }

    @Environment(\.colorScheme) private var colorScheme
    let state: VersoUpdateToastState

    var body: some View {
        cardView
            .frame(
                width: Self.cardWidth,
                height: Self.cardHeight(for: state),
                alignment: isCenteredActivity ? .center : .topLeading
            )
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(surfaceColor)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(borderColor, lineWidth: 1)
            )
            .overlay(alignment: .topTrailing) {
                closeButton
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.10), radius: 12, y: 5)
        .frame(width: Self.width, height: Self.height(for: state), alignment: .topLeading)
    }

    private static func hasActions(_ state: VersoUpdateToastState) -> Bool {
        (state.secondaryTitle != nil && state.secondaryAction != nil) ||
        (state.primaryTitle != nil && state.primaryAction != nil)
    }

    private var isCenteredActivity: Bool {
        state.progress == nil && state.showsActivity && !Self.hasActions(state) && state.closeAction == nil
    }

    private var hasActions: Bool {
        Self.hasActions(state)
    }

    private var surfaceColor: Color {
        Color(red: 37/255, green: 40/255, blue: 43/255)
    }

    private var borderColor: Color {
        Color.white.opacity(0.10)
    }

    private var titleColor: Color {
        Color.white.opacity(0.90)
    }

    private var messageColor: Color {
        Color.white.opacity(0.58)
    }

    private var secondaryTextColor: Color {
        Color.white.opacity(0.48)
    }

    private var spinnerColor: Color {
        Color.white.opacity(0.90)
    }

    private var progressTrackColor: Color {
        Color.white.opacity(0.12)
    }

    private var progressFillColor: Color {
        Color.white.opacity(0.88)
    }

    @ViewBuilder
    private var closeButton: some View {
        if let closeAction = state.closeAction {
            Button(action: closeAction) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.42))
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Dismiss")
            .accessibilityLabel("Dismiss update notification")
            .padding(.top, 8)
            .padding(.trailing, 8)
        }
    }

    @ViewBuilder
    private var cardView: some View {
        Group {
            if isCenteredActivity {
                centeredActivityView
            } else {
                standardContentView
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
    }

    @ViewBuilder
    private var standardContentView: some View {
        VStack(alignment: .leading, spacing: state.message.isEmpty ? 14 : 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(state.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)

                if !state.message.isEmpty {
                    Text(state.message)
                        .font(.system(size: 11))
                        .foregroundStyle(messageColor)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(2)
                }
            }
            .padding(.trailing, state.closeAction == nil ? 0 : 26)
            .frame(maxWidth: .infinity, alignment: .leading)

            statusView

            if hasActions {
                HStack(spacing: 12) {
                    if let secondaryTitle = state.secondaryTitle, let secondaryAction = state.secondaryAction {
                        Button(secondaryTitle, action: secondaryAction)
                            .buttonStyle(VersoUpdateSecondaryButtonStyle(colorScheme: colorScheme))
                    }

                    if let primaryTitle = state.primaryTitle, let primaryAction = state.primaryAction {
                        Button(primaryTitle, action: primaryAction)
                            .buttonStyle(VersoUpdatePrimaryButtonStyle(colorScheme: colorScheme))
                    }
                }
            }
        }
    }

    private var centeredActivityView: some View {
        HStack(alignment: .center, spacing: 10) {
            VersoUpdateProgressSpinner(color: spinnerColor)
                .frame(width: 16, height: 16)

            VStack(alignment: .leading, spacing: 2) {
                Text(state.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)

                if !state.message.isEmpty {
                    Text(state.message)
                        .font(.system(size: 11))
                        .foregroundStyle(messageColor)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    @ViewBuilder
    private var statusView: some View {
        if let progress = state.progress {
            VStack(alignment: .leading, spacing: 6) {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(progressTrackColor)
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(progressFillColor)
                            .frame(width: max(6, proxy.size.width * progress))
                    }
                }
                .frame(height: 5)

                Text("\(Int(progress * 100))%")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(secondaryTextColor)
            }
        } else if state.showsActivity {
            VersoUpdateProgressSpinner(color: spinnerColor)
                .frame(width: 16, height: 16)
        } else {
            EmptyView()
        }
    }
}

private struct VersoUpdateProgressSpinner: View {
    let color: Color

    var body: some View {
        ProgressView()
            .progressViewStyle(CircularProgressViewStyle(tint: color))
            .controlSize(.small)
            .tint(color)
            .environment(\.colorScheme, .dark)
    }
}

private struct VersoUpdatePrimaryButtonStyle: ButtonStyle {
    let colorScheme: ColorScheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Color(red: 0.11, green: 0.12, blue: 0.13))
            .padding(.horizontal, 16)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.78 : 0.90))
            )
    }
}

private struct VersoUpdateSecondaryButtonStyle: ButtonStyle {
    let colorScheme: ColorScheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.white.opacity(configuration.isPressed ? 0.54 : 0.68))
            .padding(.horizontal, 16)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.08 : 0.035))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.white.opacity(configuration.isPressed ? 0.18 : 0.12), lineWidth: 1)
            )
    }
}
