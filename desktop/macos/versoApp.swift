import SwiftUI
import AppKit
import Sparkle

@main
struct versoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var sidecar = SidecarManager()
    @StateObject private var managedSessionStore = ManagedSessionStore()
    @State private var didScheduleLaunchUpdateCheck = false

    private let updateUserDriver: VersoUpdateUserDriver
    private let updater: SPUUpdater

    init() {
        let updateUserDriver = VersoUpdateUserDriver()
        self.updateUserDriver = updateUserDriver
        self.updater = SPUUpdater(
            hostBundle: Bundle.main,
            applicationBundle: Bundle.main,
            userDriver: updateUserDriver,
            delegate: nil
        )

        do {
            try updater.start()
        } catch {
            NSLog("Failed to start Sparkle updater: \(error.localizedDescription)")
        }
    }

    var body: some Scene {
        Window("verso", id: "main") {
            RootView(sidecar: sidecar, managedSessionStore: managedSessionStore)
                .onAppear {
                    appDelegate.sidecar = sidecar
                    if !didScheduleLaunchUpdateCheck {
                        didScheduleLaunchUpdateCheck = true
                        scheduleLaunchUpdateCheck()
                    }
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
                .background(MainWindowAccessor { window in
                    appDelegate.registerMainWindow(window)
                })
        }
        .defaultSize(width: 1200, height: 750)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesView(updater: updater)
            }
        }
    }

    private func scheduleLaunchUpdateCheck() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            guard updater.automaticallyChecksForUpdates,
                  !updater.sessionInProgress else { return }
            updater.checkForUpdatesInBackground()
        }
    }
}

private struct MainWindowAccessor: NSViewRepresentable {
    let onResolve: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            if let window = view.window {
                onResolve(window)
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            if let window = nsView.window {
                onResolve(window)
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
        Button("Check for Updates…") {
            updater.checkForUpdates()
        }
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
    /// Shared reference for code that can't reach the delegate via
    /// `NSApp.delegate` — SwiftUI's `@NSApplicationDelegateAdaptor` wraps our
    /// instance inside an internal `SwiftUI.AppDelegate`, so the usual cast
    /// returns nil. ChatWebView's bridge handler uses this to call into us.
    static private(set) weak var shared: AppDelegate?

    /// Set by versoApp once the sidecar manager is constructed. We grab a
    /// reference here so applicationWillTerminate can stop it cleanly even
    /// when the @StateObject's deinit doesn't run (which is most of the time
    /// on macOS app shutdown).
    weak var sidecar: SidecarManager?

    /// Number of chat responses that completed while the app was in the
    /// background. Drives the dock badge; cleared whenever the user brings
    /// the app back to the foreground.
    private var pendingResponseCount = 0
    private weak var mainWindow: NSWindow?

    override init() {
        super.init()
        AppDelegate.shared = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowDidBecomeMain(_:)),
            name: NSWindow.didBecomeMainNotification,
            object: nil
        )
    }

    func registerMainWindow(_ window: NSWindow) {
        mainWindow = window
        configureWindow(window)
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        pendingResponseCount = 0
        NSApp.dockTile.badgeLabel = nil
    }

    /// Called by ChatWebView when a chat stream finishes. Only nudges the
    /// user when they're in another app — silent when verso is frontmost.
    func notifyResponseReady() {
        guard !NSApp.isActive else { return }
        pendingResponseCount += 1
        NSApp.dockTile.badgeLabel = String(pendingResponseCount)
        NSSound(named: "Tink")?.play()
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
              window === mainWindow else { return }
        configureWindow(window)
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
