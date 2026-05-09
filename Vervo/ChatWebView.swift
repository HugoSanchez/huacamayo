import SwiftUI
import WebKit

/// SwiftUI wrapper around WKWebView that hosts the React chat app.
/// Passes the sidecar port to JS via `window.setSidecarPort(port)`.
struct ChatWebView: NSViewRepresentable {
    let sidecarPort: Int?
    let selectedSessionId: String?
    let isDarkMode: Bool
    let isCatalogOpen: Bool
    let isSkillsCatalogOpen: Bool
    let pendingCronOpen: CronOpenRequest?
    let onSessionStateChange: ((String?) -> Void)?
    let onCatalogStateChange: ((Bool) -> Void)?
    let onSkillsCatalogStateChange: ((Bool) -> Void)?
    let onCronsChanged: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onSessionStateChange: onSessionStateChange,
            onCatalogStateChange: onCatalogStateChange,
            onSkillsCatalogStateChange: onSkillsCatalogStateChange,
            onCronsChanged: onCronsChanged
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
              if (window.__vervoBridgeInstalled) return;
              window.__vervoBridgeInstalled = true;
              window.__vervoPendingSidecarPort = null;
              var assignedHandler = null;

              Object.defineProperty(window, 'setSidecarPort', {
                configurable: true,
                enumerable: true,
                get: function() { return assignedHandler; },
                set: function(fn) {
                  assignedHandler = fn;
                  var pending = window.__vervoPendingSidecarPort;
                  if (typeof pending === 'number' && typeof assignedHandler === 'function') {
                    try { assignedHandler(pending); } catch (_) {}
                  }
                }
              });

              window.__vervoApplySidecarPort = function(port) {
                window.__vervoPendingSidecarPort = port;
              if (typeof assignedHandler === 'function') {
                try { assignedHandler(port); } catch (_) {}
              }
              };

              window.__vervoShellMode = 'native';
              window.__vervoPendingSelectedSessionId = null;
              window.__vervoApplySelectedSession = function(sessionId) {
                window.__vervoPendingSelectedSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
                window.dispatchEvent(new CustomEvent('vervo:select-session', {
                  detail: { sessionId: window.__vervoPendingSelectedSessionId }
                }));
              };

              window.__vervoPendingCatalogOpen = false;
              window.__vervoApplyCatalogState = function(open) {
                var next = !!open;
                window.__vervoPendingCatalogOpen = next;
                window.dispatchEvent(new CustomEvent('vervo:toggle-catalog', {
                  detail: { open: next }
                }));
              };

              window.__vervoPendingSkillsCatalogOpen = false;
              window.__vervoApplySkillsCatalogState = function(open) {
                var next = !!open;
                window.__vervoPendingSkillsCatalogOpen = next;
                window.dispatchEvent(new CustomEvent('vervo:toggle-skills-catalog', {
                  detail: { open: next }
                }));
              };
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
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
        context.coordinator.onSessionStateChange = onSessionStateChange
        context.coordinator.onCatalogStateChange = onCatalogStateChange

        // When sidecar port becomes available, inject it into JS
        if let port = sidecarPort, port != context.coordinator.lastInjectedPort {
            context.coordinator.pendingPort = port
            if context.coordinator.pageLoaded {
                context.coordinator.injectPort(port)
            }
        }

        let selectedSessionToken = selectedSessionId ?? "__vervo_nil_session__"
        if selectedSessionToken != context.coordinator.lastInjectedSelectedSessionToken {
            context.coordinator.pendingSelectedSessionId = selectedSessionId
            if context.coordinator.pageLoaded {
                context.coordinator.injectSelectedSession(selectedSessionId)
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
        var onSessionStateChange: ((String?) -> Void)?
        var onCatalogStateChange: ((Bool) -> Void)?
        var onSkillsCatalogStateChange: ((Bool) -> Void)?
        var onCronsChanged: (() -> Void)?
        weak var webView: WKWebView?
        var lastInjectedPort: Int?
        var pendingPort: Int?
        var lastInjectedSelectedSessionToken: String?
        var pendingSelectedSessionId: String?
        var lastInjectedCatalogOpen: Bool?
        var pendingCatalogOpen: Bool = false
        var lastInjectedSkillsCatalogOpen: Bool?
        var pendingSkillsCatalogOpen: Bool = false
        var lastInjectedCronToken: UUID?
        var pendingCronOpen: CronOpenRequest?
        var lastDarkMode: Bool?
        var pageLoaded = false

        init(
            onSessionStateChange: ((String?) -> Void)?,
            onCatalogStateChange: ((Bool) -> Void)?,
            onSkillsCatalogStateChange: ((Bool) -> Void)?,
            onCronsChanged: (() -> Void)?
        ) {
            self.onSessionStateChange = onSessionStateChange
            self.onCatalogStateChange = onCatalogStateChange
            self.onSkillsCatalogStateChange = onSkillsCatalogStateChange
            self.onCronsChanged = onCronsChanged
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageLoaded = true
            if let port = pendingPort ?? lastInjectedPort {
                injectPort(port)
            }
            injectSelectedSession(pendingSelectedSessionId)
            injectCatalogState(pendingCatalogOpen)
            injectSkillsCatalogState(pendingSkillsCatalogOpen)
            if let request = pendingCronOpen {
                injectOpenCron(request)
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
              window.__vervoSidecarPort = \(port);
              if (typeof window.__vervoApplySidecarPort === 'function') {
                window.__vervoApplySidecarPort(\(port));
              }
              if (typeof window.setSidecarPort === 'function') {
                window.setSidecarPort(\(port));
              }
              window.dispatchEvent(new CustomEvent('vervo:sidecar-port', { detail: { port: \(port) } }));
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

        func injectSelectedSession(_ sessionId: String?) {
            guard let webView else { return }

            let sessionLiteral = sessionId.map { "'\($0.jsEscaped)'" } ?? "null"
            let js = """
            (function() {
              window.__vervoPendingSelectedSessionId = \(sessionLiteral);
              if (typeof window.__vervoApplySelectedSession === 'function') {
                window.__vervoApplySelectedSession(\(sessionLiteral));
              }
            })();
            """
            webView.evaluateJavaScript(js) { _, error in
                if let error {
                    print("[ChatWebView] Failed to inject selected session: \(error.localizedDescription)")
                }
            }

            pendingSelectedSessionId = sessionId
            lastInjectedSelectedSessionToken = sessionId ?? "__vervo_nil_session__"
        }

        func injectCatalogState(_ open: Bool) {
            guard let webView else { return }
            let js = """
            (function() {
              window.__vervoPendingCatalogOpen = \(open ? "true" : "false");
              if (typeof window.__vervoApplyCatalogState === 'function') {
                window.__vervoApplyCatalogState(\(open ? "true" : "false"));
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
              window.dispatchEvent(new CustomEvent('vervo:open-cron-detail', {
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

        func injectSkillsCatalogState(_ open: Bool) {
            guard let webView else { return }
            let js = """
            (function() {
              window.__vervoPendingSkillsCatalogOpen = \(open ? "true" : "false");
              if (typeof window.__vervoApplySkillsCatalogState === 'function') {
                window.__vervoApplySkillsCatalogState(\(open ? "true" : "false"));
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

            if type == "sessionStateChanged" {
                let sessionId = body["sessionId"] as? String
                DispatchQueue.main.async { [onSessionStateChange] in
                    onSessionStateChange?(sessionId)
                }
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
