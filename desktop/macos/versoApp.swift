import SwiftUI
import AppKit
import Sparkle

@main
struct versoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var sidecar = SidecarManager()
    @StateObject private var managedSessionStore = ManagedSessionStore()

    private let updaterController = SPUStandardUpdaterController(
        startingUpdater: true,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )

    var body: some Scene {
        Window("verso", id: "main") {
            RootView(sidecar: sidecar, managedSessionStore: managedSessionStore)
                .onAppear {
                    appDelegate.sidecar = sidecar
                    sidecar.updateManagedSession(managedSessionStore.currentSession)
                    sidecar.start()
                }
                .onChange(of: managedSessionStore.currentSession) { _, session in
                    sidecar.updateManagedSession(session)
                }
                .onOpenURL { url in
                    NSApp.activate(ignoringOtherApps: true)
                    managedSessionStore.handleCallbackURL(url)
                }
        }
        .defaultSize(width: 1200, height: 750)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesView(updater: updaterController.updater)
            }
        }
    }
}

private final class CheckForUpdatesViewModel: ObservableObject {
    @Published var canCheckForUpdates = false

    init(updater: SPUUpdater) {
        updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }
}

private struct CheckForUpdatesView: View {
    @ObservedObject private var viewModel: CheckForUpdatesViewModel
    private let updater: SPUUpdater

    init(updater: SPUUpdater) {
        self.updater = updater
        self.viewModel = CheckForUpdatesViewModel(updater: updater)
    }

    var body: some View {
        Button("Check for Updates…") { updater.checkForUpdates() }
            .disabled(!viewModel.canCheckForUpdates)
    }
}

private struct RootView: View {
    @ObservedObject var sidecar: SidecarManager
    @ObservedObject var managedSessionStore: ManagedSessionStore

    var body: some View {
        if let session = managedSessionStore.currentSession, !session.isExpired {
            ContentView(sidecar: sidecar, managedSessionStore: managedSessionStore)
        } else {
            SignInView(managedSessionStore: managedSessionStore)
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    /// Set by versoApp once the sidecar manager is constructed. We grab a
    /// reference here so applicationWillTerminate can stop it cleanly even
    /// when the @StateObject's deinit doesn't run (which is most of the time
    /// on macOS app shutdown).
    weak var sidecar: SidecarManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Configure already-created windows immediately.
        configureExistingWindows()

        // Configure any window that becomes active afterwards.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowDidBecomeMain(_:)),
            name: NSWindow.didBecomeMainNotification,
            object: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Belt to the orchestrator's parent-pid watcher's suspenders: if the
        // app is quitting normally, kill the child outright instead of waiting
        // for the watcher's 2s polling cycle.
        sidecar?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Quit when the last window closes so the sidecar exits with us.
        return true
    }

    @objc func windowDidBecomeMain(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              Self.isAppWindow(window) else { return }
        configureWindow(window)
    }

    private func configureExistingWindows() {
        // WindowGroup windows may appear on the next run-loop turn.
        DispatchQueue.main.async {
            NSApplication.shared.windows
                .filter { Self.isAppWindow($0) }
                .forEach { self.configureWindow($0) }
        }
    }

    /// Only configure our own content windows, not system panels (NSOpenPanel, NSSavePanel, alerts).
    private static func isAppWindow(_ window: NSWindow) -> Bool {
        !(window is NSPanel)
    }

    private func configureWindow(_ window: NSWindow) {
        // Remove the title bar but keep window capabilities
        window.styleMask.remove(.titled)
        window.styleMask.insert(.fullSizeContentView)
        window.styleMask.insert(.resizable)
        window.styleMask.insert(.closable)
        window.styleMask.insert(.miniaturizable)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.hasShadow = true
        window.backgroundColor = .clear

        // Match Conductor's subtle rounded window corners.
        if let contentView = window.contentView {
            contentView.wantsLayer = true
            contentView.layer?.cornerRadius = 10
            contentView.layer?.cornerCurve = .continuous
            contentView.layer?.masksToBounds = true
        }
    }
}
