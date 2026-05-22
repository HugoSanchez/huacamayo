import SwiftUI
import WebKit
import AppKit

// MARK: - Shell protocol
//
// Single wire format between the Swift shell and the chat-ui WebView. Today
// the IPC is a tangle of ~14 named injection methods and per-type
// `chatBridge.postMessage` discriminators. This file is the first step
// toward consolidating that into three channels:
//
//   • Swift → JS: `verso:shell-state` carrying a full `ShellState` snapshot
//     of everything the chat-ui needs to render (sessions list, selection).
//   • Swift → JS: `verso:shell-command` for transient commands (open
//     overlays, navigate to a cron, etc.).
//   • JS → Swift: `chatBridge.postMessage({type: "action", action})` with a
//     single discriminated `ShellAction` payload.
//
// Step 1 just defines the shapes — no behavior change. See
// `.context/plans/session-state-consolidation.md` for the full plan and
// `desktop/chat-ui/src/shell-protocol.ts` for the matching TS side.

/// Snapshot of everything the chat-ui's UI derives from. Last write wins;
/// pushed from Swift after every mutation that affects what the chat-ui
/// should render.
struct ShellState: Codable, Equatable {
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
}

/// Transient command pushed from Swift to JS. Not snapshot-able (we don't
/// store the open/close state of overlays on the Swift side; the chat-ui
/// owns it).
enum ShellCommand: Equatable {
    case openCatalog
    case closeCatalog
    case openSkillsCatalog
    case closeSkillsCatalog
    case openCron(id: String)
    case openSettings
}

/// Action sent from JS → Swift via the chatBridge. One discriminated union
/// replaces the per-type `*Changed` messages we have today.
enum ShellAction: Equatable {
    case selectSession(id: String?)
    case createSession
    case archiveSession(id: String)
    case unarchiveSession(id: String)
    case renameSession(id: String, title: String)
    /// "I just streamed a message into session X; please refresh." Used so
    /// Swift's leftbar picks up the AI-generated title that lands after the
    /// first response.
    case sessionMutated(id: String)
    /// Streaming state changed for a session. The leftbar uses this to show
    /// a "working" indicator on rows whose agent is currently generating.
    case sessionStreaming(id: String, streaming: Bool)
    /// Unread response for a session — set when a stream finished while the
    /// user wasn't looking at that chat surface. The leftbar renders a small
    /// accent dot until the chat-ui says the session is being viewed again.
    case sessionUnread(id: String, unread: Bool)
    case openExternalUrl(url: String)
    case signOut
    /// User dismissed the catalog via the chat-ui's close button (rather
    /// than via a Swift-side leftbar toggle).
    case catalogClosed
    case skillsCatalogClosed
}

/// SwiftUI wrapper around WKWebView that hosts the React chat app.
/// Passes the sidecar port to JS via `window.setSidecarPort(port)`.
struct ChatWebView: NSViewRepresentable {
    let sidecarPort: Int?
    let isDarkMode: Bool
    let isCatalogOpen: Bool
    let isSkillsCatalogOpen: Bool
    let pendingCronOpen: CronOpenRequest?
    let pendingSettingsOpen: SettingsOpenRequest?
    // Full shell-state snapshot pushed to JS on every change. The chat-ui
    // derives its session list + selection off this; Swift-side mutations
    // that change either bump the snapshot automatically via SwiftUI's
    // re-render. (Replaces the older nonced-token `sessionsChangedToken`
    // and per-mutation injection channels.)
    let shellState: ShellState?
    let onCatalogStateChange: ((Bool) -> Void)?
    let onSkillsCatalogStateChange: ((Bool) -> Void)?
    let onCronsChanged: (() -> Void)?
    let onConnectionsChanged: (() -> Void)?
    let onSkillsChanged: (() -> Void)?
    let onSignOutRequested: (() -> Void)?
    /// Single consolidated JS→Swift channel. Future home for every action
    /// the chat-ui posts; today only `selectSession` and `sessionMutated`
    /// flow through here, with the per-type callbacks above slated for
    /// removal as more actions migrate.
    let onShellAction: ((ShellAction) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onCatalogStateChange: onCatalogStateChange,
            onSkillsCatalogStateChange: onSkillsCatalogStateChange,
            onCronsChanged: onCronsChanged,
            onConnectionsChanged: onConnectionsChanged,
            onSkillsChanged: onSkillsChanged,
            onSignOutRequested: onSignOutRequested,
            onShellAction: onShellAction
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Allow fetch to localhost from file:// origin
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(context.coordinator, name: "chatBridge")
        config.userContentController.addUserScript(WKUserScript(
            source: """
            (function() {
              if (window.__versoBridgeInstalled) return;
              window.__versoBridgeInstalled = true;
              window.__versoPendingSidecarPort = null;
              var assignedHandler = null;

              Object.defineProperty(window, 'setSidecarPort', {
                configurable: true,
                enumerable: true,
                get: function() { return assignedHandler; },
                set: function(fn) {
                  assignedHandler = fn;
                  var pending = window.__versoPendingSidecarPort;
                  if (typeof pending === 'number' && typeof assignedHandler === 'function') {
                    try { assignedHandler(pending); } catch (_) {}
                  }
                }
              });

              window.__versoApplySidecarPort = function(port) {
                window.__versoPendingSidecarPort = port;
              if (typeof assignedHandler === 'function') {
                try { assignedHandler(port); } catch (_) {}
              }
              };

              window.__versoShellMode = 'native';

              window.__versoPendingCatalogOpen = false;
              window.__versoApplyCatalogState = function(open) {
                var next = !!open;
                window.__versoPendingCatalogOpen = next;
                window.dispatchEvent(new CustomEvent('verso:toggle-catalog', {
                  detail: { open: next }
                }));
              };

              window.__versoPendingSkillsCatalogOpen = false;
              window.__versoApplySkillsCatalogState = function(open) {
                var next = !!open;
                window.__versoPendingSkillsCatalogOpen = next;
                window.dispatchEvent(new CustomEvent('verso:toggle-skills-catalog', {
                  detail: { open: next }
                }));
              };

              // Session-state consolidation step 2: full snapshot from Swift.
              // Swift pushes a fresh `ShellState` on every change; the chat-ui
              // mounts with whatever was last set on `__versoPendingShellState`.
              window.__versoPendingShellState = null;
              window.__versoApplyShellState = function(state) {
                window.__versoPendingShellState = state || null;
                window.dispatchEvent(new CustomEvent('verso:shell-state', {
                  detail: window.__versoPendingShellState
                }));
              };
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        // Load the bundled chat-ui
        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "chat-ui") {
            let dirURL = indexURL.deletingLastPathComponent()
            webView.loadFileURL(indexURL, allowingReadAccessTo: dirURL)
        } else {
            print("[ChatWebView] chat-ui/index.html not found in bundle")
            // Debug: list bundle resources
            if let resourcePath = Bundle.main.resourcePath {
                if let contents = try? FileManager.default.contentsOfDirectory(atPath: resourcePath) {
                    print("[ChatWebView] Bundle resources: \(contents)")
                } else {
                    print("[ChatWebView] Bundle resources could not be listed")
                }
            }
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onCatalogStateChange = onCatalogStateChange

        // When sidecar port becomes available, inject it into JS
        if let port = sidecarPort, port != context.coordinator.lastInjectedPort {
            context.coordinator.pendingPort = port
            if context.coordinator.pageLoaded {
                context.coordinator.injectPort(port)
            }
        }

        if isCatalogOpen != context.coordinator.lastInjectedCatalogOpen {
            context.coordinator.pendingCatalogOpen = isCatalogOpen
            if context.coordinator.pageLoaded {
                context.coordinator.injectCatalogState(isCatalogOpen)
            }
        }

        if isSkillsCatalogOpen != context.coordinator.lastInjectedSkillsCatalogOpen {
            context.coordinator.pendingSkillsCatalogOpen = isSkillsCatalogOpen
            if context.coordinator.pageLoaded {
                context.coordinator.injectSkillsCatalogState(isSkillsCatalogOpen)
            }
        }

        // Cron-open requests are nonced (UUID per click) so re-clicking the
        // same cron after navigating away still re-fires the JS event.
        if let request = pendingCronOpen, request.token != context.coordinator.lastInjectedCronToken {
            context.coordinator.pendingCronOpen = request
            if context.coordinator.pageLoaded {
                context.coordinator.injectOpenCron(request)
            }
        }

        // Settings-open requests follow the same nonced-token pattern so
        // clicking the gear after leaving Settings still re-opens it.
        if let request = pendingSettingsOpen, request.token != context.coordinator.lastInjectedSettingsToken {
            context.coordinator.pendingSettingsOpen = request
            if context.coordinator.pageLoaded {
                context.coordinator.injectOpenSettings(request)
            }
        }

        // Shell-state snapshot. Pushed on every change so the chat-ui can
        // drive its rendering off a single source of truth instead of N
        // overlapping injection channels. Step 2: pushed but not yet
        // consumed; old channels keep working in parallel.
        if let state = shellState, state != context.coordinator.lastInjectedShellState {
            context.coordinator.pendingShellState = state
            if context.coordinator.pageLoaded {
                context.coordinator.injectShellState(state)
            }
        }

        // Update color scheme
        if isDarkMode != context.coordinator.lastDarkMode {
            context.coordinator.lastDarkMode = isDarkMode
            let scheme = isDarkMode ? "dark" : "light"
            webView.evaluateJavaScript(
                "document.documentElement.style.colorScheme = '\(scheme)';",
                completionHandler: nil
            )
        }
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onCatalogStateChange: ((Bool) -> Void)?
        var onSkillsCatalogStateChange: ((Bool) -> Void)?
        var onCronsChanged: (() -> Void)?
        var onConnectionsChanged: (() -> Void)?
        var onSkillsChanged: (() -> Void)?
        var onSignOutRequested: (() -> Void)?
        var onShellAction: ((ShellAction) -> Void)?
        weak var webView: WKWebView?
        var lastInjectedPort: Int?
        var pendingPort: Int?
        var lastInjectedCatalogOpen: Bool?
        var pendingCatalogOpen: Bool = false
        var lastInjectedSkillsCatalogOpen: Bool?
        var pendingSkillsCatalogOpen: Bool = false
        var lastInjectedCronToken: UUID?
        var pendingCronOpen: CronOpenRequest?
        var lastInjectedSettingsToken: UUID?
        var pendingSettingsOpen: SettingsOpenRequest?
        var lastInjectedShellState: ShellState?
        var pendingShellState: ShellState?
        var lastDarkMode: Bool?
        var pageLoaded = false

        init(
            onCatalogStateChange: ((Bool) -> Void)?,
            onSkillsCatalogStateChange: ((Bool) -> Void)?,
            onCronsChanged: (() -> Void)?,
            onConnectionsChanged: (() -> Void)?,
            onSkillsChanged: (() -> Void)?,
            onSignOutRequested: (() -> Void)?,
            onShellAction: ((ShellAction) -> Void)?
        ) {
            self.onCatalogStateChange = onCatalogStateChange
            self.onSkillsCatalogStateChange = onSkillsCatalogStateChange
            self.onCronsChanged = onCronsChanged
            self.onConnectionsChanged = onConnectionsChanged
            self.onSkillsChanged = onSkillsChanged
            self.onSignOutRequested = onSignOutRequested
            self.onShellAction = onShellAction
            super.init()
            // When the system is about to sleep we tell the webview's JS to
            // stop its polling intervals. Resume on wake. NSWorkspace fires
            // these for lid-close and idle-sleep alike, which is exactly the
            // PowerNap window where we want zero CPU activity.
            let center = NSWorkspace.shared.notificationCenter
            center.addObserver(
                self,
                selector: #selector(handleSystemSleep),
                name: NSWorkspace.willSleepNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(handleSystemWake),
                name: NSWorkspace.didWakeNotification,
                object: nil
            )
        }

        deinit {
            NSWorkspace.shared.notificationCenter.removeObserver(self)
        }

        @objc private func handleSystemSleep() {
            injectSystemSleep()
        }

        @objc private func handleSystemWake() {
            injectSystemWake()
        }

        func injectSystemSleep() {
            guard let webView, pageLoaded else { return }
            webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('verso:system-sleep'));",
                completionHandler: nil
            )
        }

        func injectSystemWake() {
            guard let webView, pageLoaded else { return }
            webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('verso:system-wake'));",
                completionHandler: nil
            )
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageLoaded = true
            if let port = pendingPort ?? lastInjectedPort {
                injectPort(port)
            }
            injectCatalogState(pendingCatalogOpen)
            injectSkillsCatalogState(pendingSkillsCatalogOpen)
            if let request = pendingCronOpen {
                injectOpenCron(request)
            }
            if let request = pendingSettingsOpen {
                injectOpenSettings(request)
            }
            if let state = pendingShellState {
                injectShellState(state)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[ChatWebView] Navigation failed: \(error)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[ChatWebView] Provisional navigation failed: \(error)")
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            let scheme = url.scheme?.lowercased()
            let isExternalWebURL = scheme == "http" || scheme == "https"
            let isMainFrameNavigation = navigationAction.targetFrame?.isMainFrame ?? true

            if isExternalWebURL && isMainFrameNavigation {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            decisionHandler(.allow)
        }

        func injectPort(_ port: Int) {
            guard let webView else { return }
            let js = """
            (function() {
              window.__versoSidecarPort = \(port);
              if (typeof window.__versoApplySidecarPort === 'function') {
                window.__versoApplySidecarPort(\(port));
              }
              if (typeof window.setSidecarPort === 'function') {
                window.setSidecarPort(\(port));
              }
              window.dispatchEvent(new CustomEvent('verso:sidecar-port', { detail: { port: \(port) } }));
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject sidecar port: \(error.localizedDescription)")
                }
            }
            lastInjectedPort = port
            pendingPort = port
        }

        func injectCatalogState(_ open: Bool) {
            guard let webView else { return }
            let js = """
            (function() {
              window.__versoPendingCatalogOpen = \(open ? "true" : "false");
              if (typeof window.__versoApplyCatalogState === 'function') {
                window.__versoApplyCatalogState(\(open ? "true" : "false"));
              }
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject catalog state: \(error.localizedDescription)")
                }
            }
            pendingCatalogOpen = open
            lastInjectedCatalogOpen = open
        }

        func injectOpenCron(_ request: CronOpenRequest) {
            guard let webView else { return }
            let escapedId = request.id
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = """
            (function() {
              window.dispatchEvent(new CustomEvent('verso:open-cron-detail', {
                detail: { id: '\(escapedId)' }
              }));
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject open-cron-detail: \(error.localizedDescription)")
                }
            }
            lastInjectedCronToken = request.token
        }

        func injectShellState(_ state: ShellState) {
            guard let webView else { return }
            // ShellState is `Codable`; the resulting JSON is a valid JS
            // expression so we can splice it directly into the call.
            let encoder = JSONEncoder()
            // Stable key ordering keeps the equality check upstream cheap
            // (string compare of last-injected JSON, if we ever want it).
            encoder.outputFormatting = [.sortedKeys]
            guard let data = try? encoder.encode(state),
                  let json = String(data: data, encoding: .utf8) else {
                print("[ChatWebView] Failed to encode ShellState")
                return
            }
            let js = """
            (function() {
              if (typeof window.__versoApplyShellState === 'function') {
                window.__versoApplyShellState(\(json));
              } else {
                window.__versoPendingShellState = \(json);
              }
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject shell state: \(error.localizedDescription)")
                }
            }
            pendingShellState = state
            lastInjectedShellState = state
        }

        func injectOpenSettings(_ request: SettingsOpenRequest) {
            guard let webView else { return }
            let js = """
            (function() {
              window.dispatchEvent(new CustomEvent('verso:open-settings'));
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject open-settings: \(error.localizedDescription)")
                }
            }
            lastInjectedSettingsToken = request.token
        }

        func injectSkillsCatalogState(_ open: Bool) {
            guard let webView else { return }
            let js = """
            (function() {
              window.__versoPendingSkillsCatalogOpen = \(open ? "true" : "false");
              if (typeof window.__versoApplySkillsCatalogState === 'function') {
                window.__versoApplySkillsCatalogState(\(open ? "true" : "false"));
              }
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject skills catalog state: \(error.localizedDescription)")
                }
            }
            pendingSkillsCatalogOpen = open
            lastInjectedSkillsCatalogOpen = open
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "chatBridge",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                return
            }

            if type == "openExternalUrl",
               let rawURL = body["url"] as? String,
               let url = URL(string: rawURL) {
                NSWorkspace.shared.open(url)
                return
            }

            if type == "catalogStateChanged" {
                let open = body["open"] as? Bool ?? false
                DispatchQueue.main.async { [onCatalogStateChange] in
                    onCatalogStateChange?(open)
                }
                return
            }

            if type == "skillsCatalogStateChanged" {
                let open = body["open"] as? Bool ?? false
                DispatchQueue.main.async { [onSkillsCatalogStateChange] in
                    onSkillsCatalogStateChange?(open)
                }
                return
            }

            if type == "cronsChanged" {
                DispatchQueue.main.async { [onCronsChanged] in
                    onCronsChanged?()
                }
                return
            }

            if type == "connectionsChanged" {
                DispatchQueue.main.async { [onConnectionsChanged] in
                    onConnectionsChanged?()
                }
                return
            }

            if type == "skillsChanged" {
                DispatchQueue.main.async { [onSkillsChanged] in
                    onSkillsChanged?()
                }
                return
            }

            if type == "signOut" {
                DispatchQueue.main.async { [onSignOutRequested] in
                    onSignOutRequested?()
                }
                return
            }

            if type == "notifyResponseReady" {
                DispatchQueue.main.async {
                    AppDelegate.shared?.notifyResponseReady()
                }
                return
            }

            // Consolidated JS→Swift action channel. As more legacy
            // `*Changed` message types migrate over, this becomes the only
            // branch we need.
            if type == "action",
               let payload = body["action"] as? [String: Any],
               let action = Coordinator.parseShellAction(payload) {
                DispatchQueue.main.async { [onShellAction] in
                    onShellAction?(action)
                }
                return
            }
        }

        static func parseShellAction(_ payload: [String: Any]) -> ShellAction? {
            guard let kind = payload["kind"] as? String else { return nil }
            switch kind {
            case "select-session":
                return .selectSession(id: payload["id"] as? String)
            case "create-session":
                return .createSession
            case "archive-session":
                guard let id = payload["id"] as? String else { return nil }
                return .archiveSession(id: id)
            case "unarchive-session":
                guard let id = payload["id"] as? String else { return nil }
                return .unarchiveSession(id: id)
            case "rename-session":
                guard let id = payload["id"] as? String,
                      let title = payload["title"] as? String else { return nil }
                return .renameSession(id: id, title: title)
            case "session-mutated":
                guard let id = payload["id"] as? String else { return nil }
                return .sessionMutated(id: id)
            case "session-streaming":
                guard let id = payload["id"] as? String,
                      let streaming = payload["streaming"] as? Bool else { return nil }
                return .sessionStreaming(id: id, streaming: streaming)
            case "session-unread":
                guard let id = payload["id"] as? String,
                      let unread = payload["unread"] as? Bool else { return nil }
                return .sessionUnread(id: id, unread: unread)
            case "open-external-url":
                guard let url = payload["url"] as? String else { return nil }
                return .openExternalUrl(url: url)
            case "sign-out":
                return .signOut
            case "catalog-closed":
                return .catalogClosed
            case "skills-catalog-closed":
                return .skillsCatalogClosed
            default:
                return nil
            }
        }
    }
}

private extension String {
    var jsEscaped: String {
        self
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
    }
}
