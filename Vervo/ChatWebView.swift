import SwiftUI
import WebKit

/// SwiftUI wrapper around WKWebView that hosts the React chat app.
/// Passes the sidecar port to JS via `window.setSidecarPort(port)`.
struct ChatWebView: NSViewRepresentable {
    let sidecarPort: Int?
    let isDarkMode: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Allow fetch to localhost from file:// origin
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
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
        // When sidecar port becomes available, inject it into JS
        if let port = sidecarPort, port != context.coordinator.lastInjectedPort {
            context.coordinator.pendingPort = port
            if context.coordinator.pageLoaded {
                context.coordinator.injectPort(port)
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

    class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        var lastInjectedPort: Int?
        var pendingPort: Int?
        var lastDarkMode: Bool?
        var pageLoaded = false

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageLoaded = true
            if let port = pendingPort ?? lastInjectedPort {
                injectPort(port)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[ChatWebView] Navigation failed: \(error)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[ChatWebView] Provisional navigation failed: \(error)")
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
    }
}
