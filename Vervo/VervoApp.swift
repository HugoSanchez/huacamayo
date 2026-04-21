import SwiftUI
import AppKit

@main
struct VervoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var sidecar = SidecarManager()
    @StateObject private var modelManager = ModelManager()

    var body: some Scene {
        WindowGroup {
            Group {
                if modelManager.status == .ready {
                    ContentView(sidecar: sidecar)
                        .onAppear { sidecar.start() }
                } else {
                    ModelSetupView(modelManager: modelManager)
                }
            }
            .onAppear {
                // Launch with -forceModelSetup to show the wizard even when models exist
                let force = CommandLine.arguments.contains("-forceModelSetup")
                modelManager.checkModels(forceNeedsDownload: force)
            }
        }
        .defaultSize(width: 1200, height: 750)
        .windowStyle(.hiddenTitleBar)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
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
