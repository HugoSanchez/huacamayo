import SwiftUI
import AppKit

@main
struct verso_superdataApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
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
        guard let window = notification.object as? NSWindow else { return }
        configureWindow(window)
    }

    private func configureExistingWindows() {
        // WindowGroup windows may appear on the next run-loop turn.
        DispatchQueue.main.async {
            NSApplication.shared.windows.forEach { self.configureWindow($0) }
        }
    }

    private func configureWindow(_ window: NSWindow) {
        // Remove the title bar entirely
        window.styleMask.remove(.titled)
        window.styleMask.insert(.fullSizeContentView)
        window.styleMask.insert(.resizable)
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
