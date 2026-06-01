import Foundation
import Sentry

enum Telemetry {
    /// `context` is a short tag (e.g. "sidecar-launch") that becomes a
    /// searchable tag in Sentry — without it, two sites throwing the same
    /// URLError look identical in the dashboard.
    static func reportError(_ error: Error, context: String) {
        SentrySDK.capture(error: error) { scope in
            scope.setTag(value: context, key: "context")
        }
    }
}
