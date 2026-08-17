import SwiftUI
import AppKit
import Combine

private struct ConductorThemePalette {
    let sidebarTop: Color
    let sidebarBottom: Color
    let sidebarTintOpacity: Double
    let mainCanvas: Color
    let inputFill: Color
    let inputStroke: Color
    let rightTop: Color
    let rightBottom: Color
    let verticalDivider: Color
    let horizontalDivider: Color
    let rightDividerThickness: CGFloat
    let centerRightDividerThickness: CGFloat
    let headerTopStart: Color
    let headerTopEnd: Color
    let headerTabsStart: Color
    let headerTabsEnd: Color
    let headerDivider: Color
    let headerBottomDivider: Color
    let headerBottomDividerThickness: CGFloat
    let headerActiveLine: Color
    let footerDivider: Color
    let footerIcon: Color
    let windowBorder: Color

    // Text roles (semantic ink hierarchy). Phase 2 collapses the Phase-1b
    // micro-drift onto the canonical editorial ink scale: `ink2` = ink-2 and
    // `inkDimRow` = ink-dim (they no longer diverge from ink2 / inkDim).
    let ink: Color        // primary text — session-row titles (ink)
    let ink2: Color       // list-item names — connections, routines, skills (ink-2)
    let inkDim: Color     // section labels, chevrons, empty/secondary text (ink-dim)
    let inkDimRow: Color  // session-row trailing meta (timestamps, hover icons) (ink-dim)
    let inkFaint: Color   // index numbers, row meta / times (ink-faint)
    let green: Color      // active session + streaming/unread accent (green)
    let orange: Color     // needs-auth / failed connection status (orange)
    let iconRing: Color   // traffic-light idle ring (icon-ring)

    // Sidebar surface fills.
    let rowSelectedFill: Color
    let rowHoverFill: Color
    let cardFill: Color

    // Destructive / warning text (system red at per-mode opacities).
    let danger: Color        // inline error text
    let dangerSoft: Color    // "Disconnect" affordance
    let dangerStrong: Color  // routine delete confirmation

    // Connection-logo fallback tile.
    let iconFallbackFill: Color
    let iconFallbackText: Color

    // Floating sidebar toast.
    let toastText: Color
    let toastFill: Color
    let toastStroke: Color

    static let windowCornerRadius: CGFloat = 10
}

private enum ConductorThemes {
    // Editorial palette (Phase 2). Flat paper surfaces — the sidebar gradient
    // collapses to a single paper stop and `sidebarTintOpacity` = 1.0 fully
    // covers the blur material, so no structural edits are needed.
    static let dark = ConductorThemePalette(
        sidebarTop: Color(red: 30/255, green: 32/255, blue: 34/255),      // #1E2022 paper
        sidebarBottom: Color(red: 30/255, green: 32/255, blue: 34/255),   // #1E2022 paper
        sidebarTintOpacity: 1.0,
        mainCanvas: Color(red: 30/255, green: 32/255, blue: 34/255),      // #1E2022 paper
        inputFill: Color(red: 38/255, green: 40/255, blue: 43/255),       // #26282B paper-2
        inputStroke: Color.white.opacity(0.10),                           // line
        rightTop: Color(red: 30/255, green: 32/255, blue: 34/255),        // #1E2022 paper
        rightBottom: Color(red: 30/255, green: 32/255, blue: 34/255),     // #1E2022 paper
        verticalDivider: Color.white.opacity(0.10),                       // line
        horizontalDivider: Color.white.opacity(0.10),                     // line
        rightDividerThickness: 1,
        centerRightDividerThickness: 1,
        headerTopStart: Color(red: 30/255, green: 32/255, blue: 34/255),  // #1E2022 paper (flat)
        headerTopEnd: Color(red: 30/255, green: 32/255, blue: 34/255),    // #1E2022 paper (flat)
        headerTabsStart: Color(red: 30/255, green: 32/255, blue: 34/255), // #1E2022 paper (flat)
        headerTabsEnd: Color(red: 30/255, green: 32/255, blue: 34/255),   // #1E2022 paper (flat)
        headerDivider: Color.white.opacity(0.10),                         // line
        headerBottomDivider: Color.white.opacity(0.06),                   // line-soft
        headerBottomDividerThickness: 1,
        headerActiveLine: Color.white.opacity(0.90),                      // ink
        footerDivider: Color.white.opacity(0.06),                         // line-soft
        footerIcon: Color.white.opacity(0.46),                            // ink-dim
        windowBorder: Color.white.opacity(0.10),                          // line
        ink: Color.white.opacity(0.90),
        ink2: Color.white.opacity(0.74),
        inkDim: Color.white.opacity(0.46),
        inkDimRow: Color.white.opacity(0.46),
        inkFaint: Color.white.opacity(0.30),
        green: Color(red: 166/255, green: 192/255, blue: 122/255),   // #A6C07A
        orange: Color(red: 214/255, green: 143/255, blue: 92/255),   // #D68F5C
        iconRing: Color.white.opacity(0.14),
        rowSelectedFill: Color.white.opacity(0.05),
        rowHoverFill: Color.white.opacity(0.03),
        cardFill: Color(red: 38/255, green: 40/255, blue: 43/255).opacity(0.38), // paper-2 × 0.38
        danger: Color.red.opacity(0.88),
        dangerSoft: Color.red.opacity(0.72),
        dangerStrong: Color.red.opacity(0.92),
        iconFallbackFill: Color.white.opacity(0.08),
        iconFallbackText: Color.white.opacity(0.7),
        toastText: Color.white.opacity(0.90),                             // ink
        toastFill: Color(red: 38/255, green: 40/255, blue: 43/255),       // #26282B paper-2
        toastStroke: Color.white.opacity(0.10)                            // line
    )

    // Light mode — same editorial palette, warm paper. Row fills switch from
    // white overlays (invisible on paper) to ink-tinted lines.
    static let light = ConductorThemePalette(
        sidebarTop: Color(red: 245/255, green: 242/255, blue: 234/255),     // #F5F2EA paper
        sidebarBottom: Color(red: 245/255, green: 242/255, blue: 234/255),  // #F5F2EA paper
        sidebarTintOpacity: 1.0,
        mainCanvas: Color(red: 245/255, green: 242/255, blue: 234/255),     // #F5F2EA paper
        inputFill: Color(red: 239/255, green: 235/255, blue: 224/255),      // #EFEBE0 paper-2
        inputStroke: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),  // line
        rightTop: Color(red: 245/255, green: 242/255, blue: 234/255),       // #F5F2EA paper
        rightBottom: Color(red: 245/255, green: 242/255, blue: 234/255),    // #F5F2EA paper
        verticalDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),   // line
        horizontalDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11), // line
        rightDividerThickness: 0.5,
        centerRightDividerThickness: 0,
        headerTopStart: Color(red: 245/255, green: 242/255, blue: 234/255),  // paper (flat)
        headerTopEnd: Color(red: 245/255, green: 242/255, blue: 234/255),    // paper (flat)
        headerTabsStart: Color(red: 245/255, green: 242/255, blue: 234/255), // paper (flat)
        headerTabsEnd: Color(red: 245/255, green: 242/255, blue: 234/255),   // paper (flat)
        headerDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),        // line
        headerBottomDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.07),  // line-soft
        headerBottomDividerThickness: 0.5,
        headerActiveLine: Color(red: 52/255, green: 51/255, blue: 45/255),   // #34332D ink
        footerDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.07),  // line-soft
        footerIcon: Color(red: 143/255, green: 140/255, blue: 127/255),      // #8F8C7F ink-dim
        windowBorder: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),   // line
        ink: Color(red: 52/255, green: 51/255, blue: 45/255),                // #34332D
        ink2: Color(red: 85/255, green: 83/255, blue: 74/255),               // #55534A
        inkDim: Color(red: 143/255, green: 140/255, blue: 127/255),          // #8F8C7F
        inkDimRow: Color(red: 143/255, green: 140/255, blue: 127/255),       // #8F8C7F ink-dim
        inkFaint: Color(red: 182/255, green: 179/255, blue: 165/255),        // #B6B3A5
        green: Color(red: 109/255, green: 122/255, blue: 76/255),            // #6D7A4C
        orange: Color(red: 178/255, green: 106/255, blue: 57/255),           // #B26A39
        iconRing: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.14),
        rowSelectedFill: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.07),
        rowHoverFill: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.045),
        cardFill: Color(red: 239/255, green: 235/255, blue: 224/255).opacity(0.82), // paper-2 × 0.82
        danger: Color.red.opacity(0.74),
        dangerSoft: Color.red.opacity(0.58),
        dangerStrong: Color.red.opacity(0.78),
        iconFallbackFill: Color.black.opacity(0.06),
        iconFallbackText: Color.black.opacity(0.55),
        toastText: Color(red: 52/255, green: 51/255, blue: 45/255),          // #34332D ink
        toastFill: Color(red: 245/255, green: 242/255, blue: 234/255),       // #F5F2EA paper
        toastStroke: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11)  // line
    )
}

/// Shared font ramp for the native shell. Sizes are unchanged; emphasized roles
/// reference bundled face weights directly, not synthesized ones.
private enum ConductorType {
    static let sectionLabel = Font.custom("IBM Plex Sans SemiBold", size: 11)
    static let disclosure = Font.custom("IBM Plex Sans SemiBold", size: 8)
    static let rowTitle = Font.custom("IBM Plex Sans", size: 13)
    static let rowTitleStrong = Font.custom("IBM Plex Sans Bold", size: 13) // selected session title
    static let meta = Font.custom("IBM Plex Sans", size: 12)      // ago / status / row meta (ink-faint)
    static let caption = Font.custom("IBM Plex Sans", size: 11)
    static let captionStrong = Font.custom("IBM Plex Sans Bold", size: 11)
    static let placeholder = Font.custom("IBM Plex Sans", size: 12)
    // SF Symbol glyph sizes (kept on Font.system since they size symbols, not
    // the mono UI text). Centralized here so call sites carry no font literals.
    static let rowActionIcon = Font.system(size: 11, weight: .medium)      // session hover pencil/archive
    static let rowActionIconSmall = Font.system(size: 10, weight: .medium)  // cron hover delete
    static let trafficGlyph = Font.system(size: 8, weight: .bold)          // traffic-light hover glyph
}

struct ContentView: View {
    @ObservedObject var sidecar: SidecarManager
    @ObservedObject var managedSessionStore: ManagedSessionStore
    @AppStorage("isDarkMode") private var isDarkMode = true
    @AppStorage("isLeftSidebarExpanded") private var isLeftSidebarExpanded = true
    @AppStorage("isRightSidebarExpanded") private var isRightSidebarExpanded = false
    @AppStorage("didApplyRightSidebarClosedDefault") private var didApplyRightSidebarClosedDefault = false
    @AppStorage("isConnectionsCatalogExpanded") private var isConnectionsCatalogExpanded = false
    @AppStorage("isConnectionsListExpanded") private var isConnectionsListExpanded = true
    @AppStorage("isSessionsListExpanded") private var isSessionsListExpanded = true
    @AppStorage("isSkillsListExpanded") private var isSkillsListExpanded = true
    @AppStorage("isSkillsCatalogExpanded") private var isSkillsCatalogExpanded = false
    @AppStorage("isCronsListExpanded") private var isCronsListExpanded = true
    @AppStorage("selectedChatSessionId") private var persistedSelectedSessionId = ""
    @State private var sessions: [SidebarChatSession] = []
    @State private var selectedSessionId: String?
    // Sessions whose agent is currently generating a response. Driven by
    // `sessionStreaming` shell actions from chat-ui; rendered as an
    // equalizer-bar indicator in `SessionSidebarRow` so the user can scan
    // which conversations are "alive" without switching to each one.
    @State private var streamingSessionIds: Set<String> = []
    // Sessions with an unread response — set when a stream ended while the
    // user wasn't looking at that chat surface. Driven by `sessionUnread`
    // shell actions from chat-ui (which owns the "actively viewed" rule
    // since only it knows full overlay state). Rendered as a small accent
    // dot in the row's trailing slot.
    @State private var unreadSessionIds: Set<String> = []
    @State private var isLoadingSessions = false
    @State private var sessionError: String?
    @State private var sidebarToast: SidebarToast?
    @State private var connections: [SidebarConnection] = []
    @State private var customConnectors: [SidebarCustomConnector] = []
    private var needsCustomConnectorRefresh: Bool {
        customConnectors.contains {
            $0.status.state == "pending_auth" || $0.status.cached == true
        }
    }
    @State private var skills: [SidebarSkill] = []
    @State private var crons: [SidebarCron] = []
    @State private var pendingCronOpen: CronOpenRequest?
    @State private var pendingSettingsOpen: SettingsOpenRequest?
    // One-shot signal that asks the WebView to drop whatever page it's
    // showing (settings / skill / cron) and return to the chat surface for
    // the current session. Fired when the user taps the *already-selected*
    // session in the leftbar — selection doesn't change, so there's no shell
    // state delta to clear the overlay, yet the user clearly wants to go back.
    @State private var pendingChatFocus: ChatFocusRequest?
    @State private var hasCompletedInitialSelection = false
    @State private var isSystemAsleep = false

    init(sidecar: SidecarManager, managedSessionStore: ManagedSessionStore) {
        self.sidecar = sidecar
        self.managedSessionStore = managedSessionStore
    }

    private var theme: ConductorThemePalette {
        isDarkMode ? ConductorThemes.dark : ConductorThemes.light
    }

    private var sidecarPort: Int? {
        if case .running(let port) = sidecar.state { return port }
        return nil
    }

    private var leftSidebarWidth: CGFloat {
        isLeftSidebarExpanded ? 320 : 0
    }

    var body: some View {
        HSplitView {
            // Left sidebar
            VStack(spacing: 0) {
                if isLeftSidebarExpanded {
                    TopChromeControls(
                        isLeftSidebarExpanded: $isLeftSidebarExpanded,
                        iconColor: theme.footerIcon,
                        ringColor: theme.iconRing
                    )
                    .padding(.leading, 14)
                    .padding(.top, 14)
                    .padding(.bottom, 10)
                }

                if isLeftSidebarExpanded {
                    SessionSidebar(
                        theme: theme,
                        isDarkMode: isDarkMode,
                        sessions: sessions,
                        selectedSessionId: selectedSessionId,
                        streamingSessionIds: streamingSessionIds,
                        unreadSessionIds: unreadSessionIds,
                        isLoadingSessions: isLoadingSessions,
                        sessionError: sessionError,
                        sidecarReady: sidecarPort != nil,
                        connections: connections,
                        customConnectors: customConnectors,
                        skills: skills,
                        crons: crons,
                        isCatalogOpen: isConnectionsCatalogExpanded,
                        isSkillsCatalogOpen: isSkillsCatalogExpanded,
                        isConnectionsExpanded: $isConnectionsListExpanded,
                        isSessionsExpanded: $isSessionsListExpanded,
                        isSkillsExpanded: $isSkillsListExpanded,
                        isCronsExpanded: $isCronsListExpanded,
                        onCreateSession: {
                            Task { await createSession() }
                        },
                        onArchiveSession: { sessionId in
                            Task { await archiveSession(sessionId) }
                        },
                        onRenameSession: { sessionId, title in
                            Task { await renameSession(sessionId, title: title) }
                        },
                        onSelectSession: { sessionId in
                            selectSession(sessionId)
                        },
                        onToggleCatalog: {
                            isConnectionsCatalogExpanded.toggle()
                            if isConnectionsCatalogExpanded {
                                isSkillsCatalogExpanded = false
                            }
                        },
                        onToggleSkillsCatalog: {
                            isSkillsCatalogExpanded.toggle()
                            if isSkillsCatalogExpanded {
                                isConnectionsCatalogExpanded = false
                            }
                        },
                        onOpenCron: { cronId in
                            pendingCronOpen = CronOpenRequest(id: cronId, token: UUID())
                        },
                        onDeleteCron: { cronId in
                            Task { await deleteCron(cronId) }
                        },
                        onDisconnectConnection: { connectedAccountId in
                            Task { await disconnectConnection(connectedAccountId) }
                        },
                        onRetryCustomConnector: { connectorId in
                            Task { await retryCustomConnector(connectorId) }
                        },
                        onDisconnectCustomConnector: { connectorId in
                            Task { await disconnectCustomConnector(connectorId) }
                        }
                    )
                }

                Spacer(minLength: 0)

                if isLeftSidebarExpanded {
                    SidebarFooter(
                        isDarkMode: $isDarkMode,
                        sidecarState: sidecar.state,
                        theme: theme,
                        onOpenSettings: {
                            pendingSettingsOpen = SettingsOpenRequest(token: UUID())
                        }
                    )
                }
            }
            .background(
                ZStack {
                    SidebarVisualEffect(isDarkMode: isDarkMode)
                        .opacity(isDarkMode ? 0 : 1)

                    LinearGradient(
                        colors: [theme.sidebarTop, theme.sidebarBottom],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .opacity(theme.sidebarTintOpacity)
                }
            )
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(theme.verticalDivider)
                    .frame(width: isDarkMode ? 1 : 0.5)
                    .opacity(isLeftSidebarExpanded ? (isDarkMode ? 1 : 0.00) : 0)
            }
            .overlay(alignment: .bottom) {
                if let sidebarToast {
                    SidebarToastView(toast: sidebarToast, theme: theme, isDarkMode: isDarkMode)
                        .padding(.bottom, 52)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(minWidth: leftSidebarWidth, idealWidth: leftSidebarWidth, maxWidth: leftSidebarWidth)
            .clipped()

            // Center (main content area). The chat WebView fills the full column
            // height so the catalog overlay (rendered inside the WebView) can
            // span the full window height like the left sidebar.
            ChatWebView(
                sidecarPort: sidecarPort,
                sidecarAuthToken: sidecar.authToken,
                isDarkMode: isDarkMode,
                isCatalogOpen: isConnectionsCatalogExpanded,
                isSkillsCatalogOpen: isSkillsCatalogExpanded,
                pendingCronOpen: pendingCronOpen,
                pendingSettingsOpen: pendingSettingsOpen,
                pendingChatFocus: pendingChatFocus,
                shellState: ShellState(sessions: sessions, selectedSessionId: selectedSessionId),
                onCatalogStateChange: { open in
                    isConnectionsCatalogExpanded = open
                },
                onSkillsCatalogStateChange: { open in
                    isSkillsCatalogExpanded = open
                },
                onCronsChanged: {
                    Task { await refreshCrons() }
                },
                onConnectionsChanged: {
                    Task { await refreshConnections() }
                },
                onSkillsChanged: {
                    Task { await refreshSkills() }
                },
                onSignOutRequested: {
                    managedSessionStore.clearSession()
                },
                onShellAction: handleShellAction
            )
            .overlay(alignment: .topLeading) {
                if !isLeftSidebarExpanded {
                    TopChromeControls(
                        isLeftSidebarExpanded: $isLeftSidebarExpanded,
                        iconColor: theme.footerIcon,
                        ringColor: theme.iconRing
                    )
                    .padding(.leading, 14)
                    .padding(.top, 14)
                }
            }
            .overlay(alignment: .topTrailing) {
                Button(action: { isRightSidebarExpanded.toggle() }) {
                    SidebarToggleIcon(side: .right, color: theme.footerIcon)
                        .frame(width: 18, height: 14)
                        .padding(3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, 14)
                .padding(.top, 14)
            }
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(theme.verticalDivider)
                    .frame(width: isRightSidebarExpanded ? theme.centerRightDividerThickness : 0)
            }
            .frame(minWidth: 400, idealWidth: 600)

            // Right panel (vertical split)
            VSplitView {
                // Top: file tree area
                theme.rightTop
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(theme.horizontalDivider)
                            .frame(height: theme.rightDividerThickness)
                    }
                    .frame(minHeight: 120)

                // Bottom: tabbed area
                theme.rightBottom
                    .frame(minHeight: 120)
            }
            .overlay(alignment: .leading) {
                // Keep the center/right split in light mode almost invisible.
                Rectangle()
                    .fill(theme.rightTop)
                    .frame(width: 1)
                    .opacity(isRightSidebarExpanded ? (isDarkMode ? 0 : 0.92) : 0)
            }
            .frame(
                minWidth: isRightSidebarExpanded ? 300 : 0,
                idealWidth: isRightSidebarExpanded ? 380 : 0,
                maxWidth: isRightSidebarExpanded ? 500 : 0
            )
            .clipped()
        }
        .preferredColorScheme(isDarkMode ? .dark : .light)
        .ignoresSafeArea()
        .background(theme.mainCanvas)
        .clipShape(RoundedRectangle(cornerRadius: ConductorThemePalette.windowCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ConductorThemePalette.windowCornerRadius, style: .continuous)
                .strokeBorder(theme.windowBorder, lineWidth: 1)
        }
        .onAppear {
            if !didApplyRightSidebarClosedDefault {
                isRightSidebarExpanded = false
                didApplyRightSidebarClosedDefault = true
            }
        }
        .task(id: sidecarPort) {
            await refreshSessions()
            await refreshConnections()
            await refreshSkills()
            await refreshCrons()
        }
        // Browser OAuth and Hermes tool registration complete outside the
        // native event bridge. Poll only while a connector is genuinely
        // waiting for auth or showing its instant cached connected state;
        // live registry status ends the loop.
        .task(id: needsCustomConnectorRefresh) {
            guard needsCustomConnectorRefresh else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                } catch {
                    return
                }
                await refreshConnections()
            }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in
            isSystemAsleep = true
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in
            // One-shot resync on wake so the sidebar reflects anything that
            // happened externally (e.g. a routine fired, a connection was
            // revoked from another device). Steady-state refresh is fully
            // event-driven via the chatBridge `*Changed` messages.
            isSystemAsleep = false
            Task {
                await refreshSessions()
                await refreshConnections()
                await refreshSkills()
                await refreshCrons()
            }
        }
        .onChange(of: managedSessionStore.latestEvent?.id) { _, _ in
            guard let event = managedSessionStore.latestEvent else { return }
            showSidebarToast(event.message)
        }
        .onChange(of: managedSessionStore.currentSession?.userId) { oldUserId, newUserId in
            guard oldUserId != newUserId else { return }
            clearShellStateForAccountChange()
        }
    }

    @MainActor
    private func refreshSessions(preferredSelection: String? = nil) async {
        // Don't wipe the sidebar when the sidecar is briefly unreachable
        // (it auto-restarts; clearing creates a jarring "everything's gone"
        // moment for what is in practice a 1–2 second blip).
        guard let baseURL = sidecar.baseURL else {
            isLoadingSessions = false
            return
        }

        isLoadingSessions = true

        do {
            let url = baseURL.appendingPathComponent("chat/sessions")
            let (data, response) = try await URLSession.shared.data(for: sidecarRequest(url: url))
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarChatSessionsResponse.self, from: data)
            let nextSessions = sortSessions(decoded.sessions)
            sessions = nextSessions

            if let resolved = resolveSelectedSessionId(in: nextSessions, preferredSelection: preferredSelection) {
                setSelectedSession(resolved)
            } else if preferredSelection != nil || selectedSessionId != nil || !hasCompletedInitialSelection {
                setSelectedSession(nil)
            }
            hasCompletedInitialSelection = true
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "load-sessions")
        }

        isLoadingSessions = false
    }

    private func sidecarRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        applySidecarAuthHeader(&request)
        return request
    }

    private func applySidecarAuthHeader(_ request: inout URLRequest) {
        if let authToken = sidecar.authToken {
            request.setValue(authToken, forHTTPHeaderField: "X-Verso-Sidecar-Token")
        }
    }

    @MainActor
    private func refreshConnections() async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            let url = baseURL.appendingPathComponent("connections")
            let (data, response) = try await URLSession.shared.data(for: sidecarRequest(url: url))
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return
            }

            let decoded = try JSONDecoder().decode(SidebarConnectionsResponse.self, from: data)
            connections = decoded.connections
        } catch {
            // Keep the last known list when refresh fails.
        }

        do {
            let url = baseURL.appendingPathComponent("connectors/custom")
            let (data, response) = try await URLSession.shared.data(for: sidecarRequest(url: url))
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return
            }

            let decoded = try JSONDecoder().decode(SidebarCustomConnectorsResponse.self, from: data)
            customConnectors = decoded.connectors.map { connector in
                var connector = connector
                if let logoUrl = connector.logoUrl,
                   logoUrl.hasPrefix("/"),
                   let resolved = URL(string: logoUrl, relativeTo: baseURL) {
                    connector.logoUrl = resolved.absoluteURL.absoluteString
                }
                return connector
            }
        } catch {
            // Keep the last known list when refresh fails.
        }
    }

    @MainActor
    private func disconnectConnection(_ connectedAccountId: String) async {
        guard let baseURL = sidecar.baseURL else { return }
        let original = connections
        // Optimistic removal mirrors `deleteCron`: the row vanishes
        // immediately so the click feels instant; we roll back if the
        // sidecar rejects the call and let the periodic refresh re-sync
        // the canonical state on success.
        connections.removeAll { $0.connectedAccountId == connectedAccountId }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("connections/\(connectedAccountId)"))
            request.httpMethod = "DELETE"
            applySidecarAuthHeader(&request)
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }
        } catch {
            connections = original
        }
        await refreshConnections()
    }

    @MainActor
    private func retryCustomConnector(_ connectorId: String) async {
        guard let baseURL = sidecar.baseURL else { return }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("connectors/custom/\(connectorId)/retry"))
            request.httpMethod = "POST"
            applySidecarAuthHeader(&request)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarCustomConnectorResponse.self, from: data)
            if decoded.connector.status.state == "pending_auth" {
                NSWorkspace.shared.open(baseURL.appendingPathComponent("connectors/custom/\(connectorId)/open"))
            }
        } catch {
            // The next refresh will restore the canonical state if retry failed.
        }
        await refreshConnections()
    }

    @MainActor
    private func disconnectCustomConnector(_ connectorId: String) async {
        guard let baseURL = sidecar.baseURL else { return }
        let original = customConnectors
        customConnectors.removeAll { $0.id == connectorId }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("connectors/custom/\(connectorId)"))
            request.httpMethod = "DELETE"
            applySidecarAuthHeader(&request)
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }
        } catch {
            customConnectors = original
        }
        await refreshConnections()
    }

    @MainActor
    private func deleteCron(_ id: String) async {
        guard let baseURL = sidecar.baseURL else { return }
        let original = crons
        // Optimistic: remove from sidebar immediately so the row dismiss
        // feels instant. If the server rejects, restore on next refresh.
        crons.removeAll { $0.id == id }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("crons/\(id)"))
            request.httpMethod = "DELETE"
            applySidecarAuthHeader(&request)
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }
        } catch {
            // Roll back the optimistic removal and let the periodic refresh
            // re-sync the canonical state.
            crons = original
        }
        await refreshCrons()
    }

    @MainActor
    private func refreshCrons() async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            let url = baseURL.appendingPathComponent("crons")
            let (data, response) = try await URLSession.shared.data(for: sidecarRequest(url: url))
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return
            }

            let decoded = try JSONDecoder().decode(SidebarCronsResponse.self, from: data)
            crons = decoded.crons
        } catch {
            // Keep the last known list when refresh fails.
        }
    }

    @MainActor
    private func refreshSkills() async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            let url = baseURL.appendingPathComponent("skills")
            let (data, response) = try await URLSession.shared.data(for: sidecarRequest(url: url))
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return
            }

            let decoded = try JSONDecoder().decode(SidebarSkillsResponse.self, from: data)
            skills = decoded.skills
        } catch {
            // Keep the last known list when refresh fails.
        }
    }

    @MainActor
    private func toggleSkill(_ slug: String, enabled: Bool) async {
        guard let baseURL = sidecar.baseURL else { return }
        do {
            var request = URLRequest(
                url: baseURL.appendingPathComponent("skills/\(slug)/toggle")
            )
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            applySidecarAuthHeader(&request)
            request.httpBody = try JSONEncoder().encode(SidebarSkillToggleRequest(enabled: enabled))
            _ = try await URLSession.shared.data(for: request)
            await refreshSkills()
        } catch {
            // Best-effort; fall back to next refresh tick.
        }
    }

    @MainActor
    private func createSession() async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("chat/sessions"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            applySidecarAuthHeader(&request)
            request.httpBody = Data("{}".utf8)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarChatSessionEnvelope.self, from: data)
            sessions = sortSessions(replacing(decoded.session, in: sessions))
            setSelectedSession(decoded.session.id)
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "create-session")
        }
    }

    @MainActor
    private func archiveSession(_ sessionId: String) async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            var request = URLRequest(
                url: baseURL.appendingPathComponent("chat/sessions/\(sessionId)/archive")
            )
            request.httpMethod = "POST"
            applySidecarAuthHeader(&request)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarChatSessionEnvelope.self, from: data)
            let nextSessions = sortSessions(replacing(decoded.session, in: sessions))
            sessions = nextSessions
            if selectedSessionId == decoded.session.id {
                setSelectedSession(nil)
            }
            sessionError = nil
            showSidebarToast("Session archived")
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "archive-session")
        }
    }

    @MainActor
    private func renameSession(_ sessionId: String, title: String) async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            var request = URLRequest(
                url: baseURL.appendingPathComponent("chat/sessions/\(sessionId)/rename")
            )
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            applySidecarAuthHeader(&request)
            request.httpBody = try JSONEncoder().encode(SidebarRenameSessionRequest(title: title))

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarChatSessionEnvelope.self, from: data)
            sessions = sortSessions(replacing(decoded.session, in: sessions))
            if selectedSessionId == decoded.session.id {
                setSelectedSession(decoded.session.id)
            }
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "rename-session")
        }
    }

    @MainActor
    private func resumeArchivedSession(_ sessionId: String) async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            var request = URLRequest(
                url: baseURL.appendingPathComponent("chat/sessions/\(sessionId)/unarchive")
            )
            request.httpMethod = "POST"
            applySidecarAuthHeader(&request)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarChatSessionEnvelope.self, from: data)
            sessions = sortSessions(replacing(decoded.session, in: sessions))
            setSelectedSession(decoded.session.id)
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "resume-archived-session")
        }
    }

    /// Single entry point for every JS→Swift action over the new
    /// `ShellAction` channel. Step 5 of session-state consolidation —
    /// today only `selectSession` and `sessionMutated` flow through here.
    /// Other cases will subsume the legacy per-type chatBridge handlers as
    /// the chat-ui migrates each mutation over.
    @MainActor
    private func handleShellAction(_ action: ShellAction) {
        switch action {
        case .selectSession(let id):
            setSelectedSession(id)
            Task { await refreshSessions(preferredSelection: id) }
        case .sessionMutated:
            Task { await refreshSessions() }
        case .sessionStreaming(let id, let streaming):
            if streaming {
                streamingSessionIds.insert(id)
            } else {
                streamingSessionIds.remove(id)
            }
        case .sessionUnread(let id, let unread):
            if unread {
                unreadSessionIds.insert(id)
            } else {
                unreadSessionIds.remove(id)
            }
        case .createSession,
             .archiveSession,
             .unarchiveSession,
             .renameSession,
             .openExternalUrl,
             .signOut,
             .catalogClosed,
             .skillsCatalogClosed:
            // Not yet migrated — JS still uses the legacy per-type
            // chatBridge messages for these. They'll move here in later
            // consolidation steps.
            break
        }
    }

    @MainActor
    private func selectSession(_ sessionId: String) {
        guard selectedSessionId != sessionId else {
            // Re-tapping the active session: selection is unchanged, so the
            // WebView won't see a shell-state delta to clear an open page.
            // Nudge it back to the chat surface explicitly.
            pendingChatFocus = ChatFocusRequest(token: UUID())
            return
        }
        if let session = sessions.first(where: { $0.id == sessionId }),
           session.archivedAt != nil {
            Task { await resumeArchivedSession(sessionId) }
            return
        }
        setSelectedSession(sessionId)
        sessionError = nil
    }

    private func setSelectedSession(_ sessionId: String?) {
        selectedSessionId = sessionId
        persistedSelectedSessionId = sessionId ?? ""
    }

    @MainActor
    private func clearShellStateForAccountChange() {
        sessions = []
        selectedSessionId = nil
        persistedSelectedSessionId = ""
        streamingSessionIds = []
        unreadSessionIds = []
        isLoadingSessions = false
        sessionError = nil
        connections = []
        customConnectors = []
        skills = []
        crons = []
        pendingCronOpen = nil
        pendingSettingsOpen = nil
        pendingChatFocus = nil
        hasCompletedInitialSelection = false
    }

    private func resolveSelectedSessionId(
        in sessions: [SidebarChatSession],
        preferredSelection: String?,
    ) -> String? {
        let candidates = [
            preferredSelection,
            selectedSessionId,
        ]

        for candidate in candidates {
            guard let candidate,
                  sessions.contains(where: { $0.id == candidate }) else { continue }
            return candidate
        }

        return nil
    }

    private func showSidebarToast(_ message: String) {
        let toast = SidebarToast(id: UUID(), message: message)
        sidebarToast = toast

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.8))
            if sidebarToast?.id == toast.id {
                withAnimation(.easeInOut(duration: 0.18)) {
                    sidebarToast = nil
                }
            }
        }
    }
}

private struct SessionSidebar: View {
    let theme: ConductorThemePalette
    let isDarkMode: Bool
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
    let streamingSessionIds: Set<String>
    let unreadSessionIds: Set<String>
    let isLoadingSessions: Bool
    let sessionError: String?
    let sidecarReady: Bool
    let connections: [SidebarConnection]
    let customConnectors: [SidebarCustomConnector]
    let skills: [SidebarSkill]
    let crons: [SidebarCron]
    let isCatalogOpen: Bool
    let isSkillsCatalogOpen: Bool
    @Binding var isConnectionsExpanded: Bool
    @Binding var isSessionsExpanded: Bool
    @Binding var isSkillsExpanded: Bool
    @Binding var isCronsExpanded: Bool
    let onCreateSession: () -> Void
    let onArchiveSession: (String) -> Void
    let onRenameSession: (String, String) -> Void
    let onSelectSession: (String) -> Void
    let onToggleCatalog: () -> Void
    let onToggleSkillsCatalog: () -> Void
    let onOpenCron: (String) -> Void
    let onDeleteCron: (String) -> Void
    let onDisconnectConnection: (String) -> Void
    let onRetryCustomConnector: (String) -> Void
    let onDisconnectCustomConnector: (String) -> Void

    @State private var renamingSessionId: String?
    @State private var draftTitle = ""

    private var secondaryText: Color {
        theme.inkDim
    }

    private var activeSessions: [SidebarChatSession] {
        sessions.filter { $0.archivedAt == nil }
    }

    private func cronTitle(_ cron: SidebarCron) -> String {
        let name = cron.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Scheduled routine" }
        if looksLikeScheduleExpression(name) {
            return humanizedSidebarSchedule(name) ?? "Scheduled routine"
        }
        return name
    }

    private func cronSubtitle(_ cron: SidebarCron) -> String? {
        if cron.state == "paused" { return "Disabled" }
        if let next = cron.nextRunAt, let date = parseISODate(next) {
            if date.timeIntervalSinceNow < 0 { return humanizedSidebarSchedule(cron.scheduleDisplay) }
            return "next " + relativeTime(date)
        }
        return humanizedSidebarSchedule(cron.scheduleDisplay)
    }

    private func humanizedSidebarSchedule(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }

        if let duration = humanizedDurationSchedule(value) {
            return duration
        }

        let lowered = value.lowercased()
        if lowered.hasPrefix("every ") {
            return value
        }

        guard looksLikeScheduleExpression(value) else {
            return value
        }

        return humanizedCronExpression(value)
    }

    private func humanizedDurationSchedule(_ value: String) -> String? {
        let pattern = #"^(?:every\s+)?(\d+)\s*([mhd])$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range), match.numberOfRanges == 3,
              let amountRange = Range(match.range(at: 1), in: value),
              let unitRange = Range(match.range(at: 2), in: value),
              let amount = Int(value[amountRange]) else {
            return nil
        }
        let unit = String(value[unitRange]).lowercased()
        let label: String
        switch unit {
        case "m": label = amount == 1 ? "minute" : "minutes"
        case "h": label = amount == 1 ? "hour" : "hours"
        case "d": label = amount == 1 ? "day" : "days"
        default: return nil
        }
        return "Every \(amount) \(label)"
    }

    private func looksLikeScheduleExpression(_ value: String) -> Bool {
        let parts = value.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 5 || parts.count == 6 else { return false }
        let allowed = CharacterSet(charactersIn: "0123456789*,-/LW?#ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        return parts.allSatisfy { part in
            !part.isEmpty && part.unicodeScalars.allSatisfy { allowed.contains($0) }
        }
    }

    private func humanizedCronExpression(_ value: String) -> String? {
        let parts = value.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        let fields = parts.count == 6 ? Array(parts.dropFirst()) : parts
        guard fields.count == 5 else { return nil }
        let minute = fields[0]
        let hour = fields[1]
        let dayOfMonth = fields[2]
        let month = fields[3]
        let dayOfWeek = fields[4]

        if let amount = stepAmount(minute), hour == "*", dayOfMonth == "*", month == "*", dayOfWeek == "*" {
            return "Every \(amount) \(amount == 1 ? "minute" : "minutes")"
        }

        if minute == "0", let amount = stepAmount(hour), dayOfMonth == "*", month == "*", dayOfWeek == "*" {
            return "Every \(amount) \(amount == 1 ? "hour" : "hours")"
        }

        if minute == "0", dayOfMonth == "*", month == "*", isWeekdayCron(dayOfWeek) {
            if hour.contains("-") || hour == "*" || hour.contains("/") {
                return "Hourly weekdays"
            }
            if let hour = Int(hour) {
                return "Weekdays at \(formattedHour(hour))"
            }
        }

        if minute == "0", hour == "*", dayOfMonth == "*", month == "*" {
            return isWeekdayCron(dayOfWeek) ? "Hourly weekdays" : "Hourly"
        }

        if minute == "0", dayOfMonth == "*", month == "*", dayOfWeek == "*" || dayOfWeek == "?" {
            if let hour = Int(hour) {
                return "Daily at \(formattedHour(hour))"
            }
        }

        return nil
    }

    private func isWeekdayCron(_ value: String) -> Bool {
        let normalized = value.uppercased()
        return normalized == "1-5" || normalized == "MON-FRI"
    }

    private func stepAmount(_ value: String) -> Int? {
        guard value.hasPrefix("*/") else { return nil }
        return Int(value.dropFirst(2))
    }

    private func formattedHour(_ hour: Int) -> String {
        let normalized = ((hour % 24) + 24) % 24
        if normalized == 0 { return "12 AM" }
        if normalized < 12 { return "\(normalized) AM" }
        if normalized == 12 { return "12 PM" }
        return "\(normalized - 12) PM"
    }

    private func parseISODate(_ raw: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let sessionError, !sessionError.isEmpty {
                Text(sessionError)
                    .font(ConductorType.caption)
                    .foregroundStyle(theme.danger)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(cardFill)
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(theme.inputStroke, lineWidth: 1)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "sessions",
                            isExpanded: $isSessionsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: onCreateSession,
                            addEnabled: sidecarReady,
                            addHelp: "New session"
                        )

                        if isSessionsExpanded {
                            SessionSidebarSection(
                                title: nil,
                                emptyText: sidecarReady ? "No sessions yet." : "Sessions will appear once the sidecar is ready.",
                                sessions: activeSessions,
                                selectedSessionId: selectedSessionId,
                                streamingSessionIds: streamingSessionIds,
                                unreadSessionIds: unreadSessionIds,
                                theme: theme,
                                isDarkMode: isDarkMode,
                                renamingSessionId: renamingSessionId,
                                draftTitle: draftTitle,
                                onDraftTitleChange: { draftTitle = $0 },
                                onSelectSession: onSelectSession,
                                onArchiveSession: onArchiveSession,
                                onBeginRename: beginRename,
                                onCommitRename: commitRename
                            )
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "connections",
                            isExpanded: $isConnectionsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: onToggleCatalog,
                            addEnabled: sidecarReady,
                            addHelp: "Browse connections"
                        )

                        if isConnectionsExpanded {
                            VStack(alignment: .leading, spacing: 0) {
                                if connections.isEmpty && customConnectors.isEmpty {
                                    Text("No connected tools")
                                        .font(ConductorType.placeholder)
                                        .foregroundStyle(secondaryText)
                                } else {
                                    ForEach(connections) { connection in
                                        SidebarConnectionRow(
                                            connection: connection,
                                            theme: theme,
                                            onDisconnect: { onDisconnectConnection(connection.connectedAccountId) }
                                        )
                                    }
                                    ForEach(customConnectors) { connector in
                                        SidebarCustomConnectorRow(
                                            connector: connector,
                                            theme: theme,
                                            onRetry: { onRetryCustomConnector(connector.id) },
                                            onDisconnect: { onDisconnectCustomConnector(connector.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "skills",
                            isExpanded: $isSkillsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: onToggleSkillsCatalog,
                            addEnabled: sidecarReady,
                            addHelp: "Browse skills"
                        )

                        if isSkillsExpanded {
                            let pinnedSkills = skills.filter { $0.pinned }
                            VStack(alignment: .leading, spacing: 0) {
                                if pinnedSkills.isEmpty {
                                    Text("No skills pinned")
                                        .font(ConductorType.placeholder)
                                        .foregroundStyle(secondaryText)
                                } else {
                                    ForEach(pinnedSkills) { skill in
                                        SidebarSkillRow(skill: skill, theme: theme)
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "routines",
                            isExpanded: $isCronsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: nil,
                            addEnabled: false,
                            addHelp: ""
                        )

                        if isCronsExpanded {
                            VStack(alignment: .leading, spacing: 0) {
                                if crons.isEmpty {
                                    Text("No routines yet")
                                        .font(ConductorType.placeholder)
                                        .foregroundStyle(secondaryText)
                                } else {
                                    ForEach(crons) { cron in
                                        SidebarCronRow(
                                            cron: cron,
                                            title: cronTitle(cron),
                                            subtitle: cronSubtitle(cron),
                                            theme: theme,
                                            onOpen: { onOpenCron(cron.id) },
                                            onDelete: { onDeleteCron(cron.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 22)
    }

    private var cardFill: Color {
        theme.cardFill
    }

    private func beginRename(_ session: SidebarChatSession) {
        renamingSessionId = session.id
        draftTitle = session.title
    }

    private func commitRename(_ session: SidebarChatSession) {
        let trimmed = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingSessionId = nil
        // Hand focus back so the chat WebView can become first responder cleanly.
        NSApp.keyWindow?.makeFirstResponder(nil)
        NotificationCenter.default.post(name: .versoRestoreKeyboardFocus, object: nil)
        guard !trimmed.isEmpty, trimmed != session.title else { return }
        onRenameSession(session.id, trimmed)
    }
}

/// Lowercase, letterspaced section header (`sessions`, `connections (N)`, …)
/// with a subtle expand/collapse chevron and the mockup's plain-`+` add glyph.
/// Behaviors are unchanged — the label/chevron toggle `isExpanded`, the `+`
/// fires `onAdd` — only the presentation is editorial.
private struct SidebarSectionHead: View {
    let label: String
    @Binding var isExpanded: Bool
    let dimText: Color    // ink-dim (label)
    let faintText: Color  // ink-faint (chevron, add glyph)
    let onAdd: (() -> Void)?
    let addEnabled: Bool
    let addHelp: String

    var body: some View {
        HStack(spacing: 6) {
            Button(action: {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            }) {
                HStack(spacing: 6) {
                    Text(label)
                        .font(ConductorType.sectionLabel)
                        .tracking(1.5)
                        .textCase(.lowercase)
                        .foregroundStyle(dimText)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(ConductorType.disclosure)
                        .foregroundStyle(faintText)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let onAdd {
                SidebarSectionAddButton(
                    action: onAdd,
                    faintText: faintText,
                    dimText: dimText,
                    enabled: addEnabled,
                    help: addHelp
                )
            }
        }
    }
}

/// The mockup's `.sec-add`: a plain `+` text glyph, ink-faint, hover → ink-dim,
/// no background. Keeps the section's create/browse action wiring untouched.
private struct SidebarSectionAddButton: View {
    let action: () -> Void
    let faintText: Color
    let dimText: Color
    let enabled: Bool
    let help: String
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text("+")
                .font(ConductorType.sectionLabel)
                .foregroundStyle(isHovered ? dimText : faintText)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .onHover { isHovered = $0 }
        .help(help)
    }
}

/// Pinned-skill row (`.row2`): name left (ink-2 → hover ink), `/slug` meta
/// right (ink-faint). Display-only, matching the previous behavior.
private struct SidebarSkillRow: View {
    let skill: SidebarSkill
    let theme: ConductorThemePalette
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 12) {
            Text(skill.name)
                .font(ConductorType.rowTitle)
                .foregroundStyle(isHovered ? theme.ink : theme.ink2)
                .lineLimit(1)

            Spacer(minLength: 0)

            Text("/" + skill.slug)
                .font(ConductorType.meta)
                .foregroundStyle(theme.inkFaint)
                .lineLimit(1)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
    }
}

private struct SessionSidebarSection: View {
    let title: String?
    let emptyText: String
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
    let streamingSessionIds: Set<String>
    let unreadSessionIds: Set<String>
    let theme: ConductorThemePalette
    let isDarkMode: Bool
    let renamingSessionId: String?
    let draftTitle: String
    let onDraftTitleChange: (String) -> Void
    let onSelectSession: (String) -> Void
    let onArchiveSession: ((String) -> Void)?
    let onBeginRename: (SidebarChatSession) -> Void
    let onCommitRename: (SidebarChatSession) -> Void

    private var secondaryText: Color {
        theme.inkDim
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(ConductorType.sectionLabel)
                    .tracking(1.5)
                    .textCase(.lowercase)
                    .foregroundStyle(secondaryText)
            }

            if sessions.isEmpty {
                Text(emptyText)
                    .font(ConductorType.placeholder)
                    .foregroundStyle(secondaryText)
                    .padding(.vertical, 6)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                        SessionSidebarRow(
                            session: session,
                            displayIndex: index + 1,
                            isSelected: session.id == selectedSessionId,
                            isStreaming: streamingSessionIds.contains(session.id),
                            isUnread: unreadSessionIds.contains(session.id),
                            theme: theme,
                            isDarkMode: isDarkMode,
                            isRenaming: renamingSessionId == session.id,
                            draftTitle: draftTitle,
                            onDraftTitleChange: onDraftTitleChange,
                            onSelectSession: onSelectSession,
                            onArchiveSession: onArchiveSession,
                            onBeginRename: onBeginRename,
                            onCommitRename: onCommitRename
                        )
                    }
                }
            }
        }
    }
}

private struct SessionSidebarRow: View {
    let session: SidebarChatSession
    let displayIndex: Int
    let isSelected: Bool
    let isStreaming: Bool
    let isUnread: Bool
    let theme: ConductorThemePalette
    let isDarkMode: Bool
    let isRenaming: Bool
    let draftTitle: String
    let onDraftTitleChange: (String) -> Void
    let onSelectSession: (String) -> Void
    let onArchiveSession: ((String) -> Void)?
    let onBeginRename: (SidebarChatSession) -> Void
    let onCommitRename: (SidebarChatSession) -> Void
    @State private var isHovered = false

    // Editorial `.sess` ink scale: index → ink-faint (ink-dim when selected),
    // title → ink-2 (ink on hover, ink + SemiBold when selected). No fill.
    private var indexColor: Color {
        isSelected ? theme.inkDim : theme.inkFaint
    }

    private var titleColor: Color {
        if isSelected || isHovered { return theme.ink }
        return theme.ink2
    }

    private var titleFont: Font {
        isSelected ? ConductorType.rowTitleStrong : ConductorType.rowTitle
    }

    // ink-faint for trailing meta; ink-dim for the hover action glyphs.
    private var metaColor: Color { theme.inkFaint }
    private var actionColor: Color { theme.inkDim }

    var body: some View {
        // `.center` (not baseline) keeps the transient trailing controls
        // (equalizer / unread dot / hover actions) vertically stable; the
        // index and title share the same 13pt size so the visual result
        // matches the mockup's baseline grid.
        HStack(alignment: .center, spacing: 10) {
            Text(String(format: "%02d", displayIndex))
                .font(ConductorType.rowTitle)
                .foregroundStyle(indexColor)
                .frame(width: 22, alignment: .leading)

            if isRenaming {
                RenameTextField(
                    text: Binding(
                        get: { draftTitle },
                        set: onDraftTitleChange
                    ),
                    isDarkMode: isDarkMode,
                    onCommit: { onCommitRename(session) },
                    onCancel: {
                        onDraftTitleChange(session.title)
                        onCommitRename(session)
                    }
                )
                .frame(maxWidth: .infinity)
            } else {
                Text(session.title)
                    .font(titleFont)
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) {
                        onBeginRename(session)
                    }
            }

            if isHovered, !isRenaming {
                HStack(spacing: 2) {
                    Button(action: { onBeginRename(session) }) {
                        Image(systemName: "pencil")
                            .font(ConductorType.rowActionIcon)
                            .foregroundStyle(actionColor)
                            .frame(width: 18, height: 16)
                    }
                    .buttonStyle(.plain)
                    .help("Rename session")

                    if let onArchiveSession, session.archivedAt == nil {
                        Button(action: { onArchiveSession(session.id) }) {
                            Image(systemName: "archivebox")
                                .font(ConductorType.rowActionIcon)
                                .foregroundStyle(actionColor)
                                .frame(width: 18, height: 16)
                        }
                        .buttonStyle(.plain)
                        .help("Archive session")
                    }
                }
            } else if isStreaming, !isRenaming {
                // "Agent is working" indicator. Takes the slot the timestamp
                // would otherwise occupy so the row height stays stable, and
                // yields back to the hover-actions when the user is reaching
                // for rename/archive.
                EqualizerBars(color: theme.green)
                    .help("Agent is working")
            } else if isUnread, !isRenaming {
                // Unread response. Same slot as the working indicator so
                // the row width stays constant. Only one of {streaming,
                // unread} can be true at a time (unread fires *after* a
                // stream ends).
                Circle()
                    .fill(theme.green)
                    .frame(width: 7, height: 7)
                    .help("New response")
            } else if !isRenaming {
                Text(sessionTimestampLabel(session))
                    .font(ConductorType.meta)
                    .foregroundStyle(metaColor)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isRenaming else { return }
            onSelectSession(session.id)
        }
        .onHover { isHovered = $0 }
    }
}

/// Three small vertical bars that independently bounce in height — the
/// canonical "audio is playing / agent is generating" cue you see in iOS
/// Music, the macOS menu-bar Now Playing indicator, etc.
///
/// Drives heights off a single `TimelineView(.animation)` clock with a
/// per-bar phase offset so the bars feel alive rather than marching in
/// lockstep. Cheap to render and doesn't depend on view-lifecycle quirks
/// the way a `.repeatForever` animation can.
private struct EqualizerBars: View {
    let color: Color
    private let barWidth: CGFloat = 2
    private let barSpacing: CGFloat = 2
    private let minHeight: CGFloat = 3
    private let maxHeight: CGFloat = 11
    /// Seconds per full bounce. Slightly faster than a heartbeat — fast
    /// enough to read as "active", slow enough to not feel jittery.
    private let period: Double = 0.85

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: barSpacing) {
                bar(height: height(for: t, phase: 0.0))
                bar(height: height(for: t, phase: 0.33))
                bar(height: height(for: t, phase: 0.66))
            }
            .frame(height: maxHeight)
        }
    }

    private func bar(height: CGFloat) -> some View {
        Capsule(style: .continuous)
            .fill(color)
            .frame(width: barWidth, height: height)
    }

    /// Maps the current clock + per-bar phase offset to a height between
    /// `minHeight` and `maxHeight` using a sine wave. `phase` is fractional
    /// (0…1) — adding 1/3 between bars spreads them across the cycle.
    private func height(for time: TimeInterval, phase: Double) -> CGFloat {
        let cycle = (time / period + phase).truncatingRemainder(dividingBy: 1)
        // 0…1 → -1…1 → 0…1 with a sine curve (smoother ease than triangular).
        let eased = (sin(cycle * 2 * .pi) + 1) / 2
        return minHeight + (maxHeight - minHeight) * eased
    }
}

struct CronOpenRequest: Equatable {
    let id: String
    let token: UUID
}

struct SettingsOpenRequest: Equatable {
    let token: UUID
}

struct ChatFocusRequest: Equatable {
    let token: UUID
}

private struct SidebarCronRow: View {
    let cron: SidebarCron
    let title: String
    let subtitle: String?
    let theme: ConductorThemePalette
    let onOpen: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false
    @State private var confirmingDelete = false
    @State private var confirmResetTask: Task<Void, Never>?

    private var isDisabled: Bool {
        cron.state == "paused"
    }

    // `.row2`: name left (ink-2 → hover ink; ink-dim when paused), meta right
    // (the next-run / schedule subtitle, ink-faint).
    private var nameColor: Color {
        if isDisabled { return theme.inkDim }
        return isHovered ? theme.ink : theme.ink2
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                Text(title)
                    .font(ConductorType.rowTitle)
                    .foregroundStyle(nameColor)
                    .lineLimit(1)

                Spacer(minLength: 0)

                if confirmingDelete {
                    Button(action: handleDeleteTap) {
                        Text("Confirm")
                            .font(ConductorType.caption)
                            .foregroundStyle(theme.dangerStrong)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Click to delete")
                } else if isHovered {
                    Button(action: handleDeleteTap) {
                        Image(systemName: "archivebox")
                            .font(ConductorType.rowActionIconSmall)
                            .foregroundStyle(theme.inkDim)
                            .frame(width: 16, height: 16)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete routine")
                } else if let subtitle {
                    Text(subtitle)
                        .font(ConductorType.meta)
                        .foregroundStyle(theme.inkFaint)
                        .opacity(isDisabled ? 0.86 : 1)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
            if !hovering {
                resetConfirm()
            }
        }
    }

    private func handleDeleteTap() {
        if confirmingDelete {
            confirmResetTask?.cancel()
            confirmResetTask = nil
            confirmingDelete = false
            onDelete()
            return
        }
        confirmingDelete = true
        confirmResetTask?.cancel()
        confirmResetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled {
                confirmingDelete = false
            }
        }
    }

    private func resetConfirm() {
        confirmResetTask?.cancel()
        confirmResetTask = nil
        confirmingDelete = false
    }
}

struct SidebarCron: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let scheduleDisplay: String?
    let nextRunAt: String?
    let lastStatus: String?
    let lastError: String?
    let state: String
    let enabled: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case scheduleDisplay = "schedule_display"
        case nextRunAt = "next_run_at"
        case lastStatus = "last_status"
        case lastError = "last_error"
        case state
        case enabled
    }
}

struct SidebarCronsResponse: Decodable {
    let crons: [SidebarCron]
}

private struct SidebarSkill: Decodable, Identifiable, Equatable {
    let slug: String
    let name: String
    let description: String
    let category: String?
    let tags: [String]
    let prerequisites: [String]
    let platforms: [String]
    let enabled: Bool
    let pinned: Bool

    var id: String { slug }
}

private struct SidebarSkillsResponse: Decodable {
    let skills: [SidebarSkill]
}

private struct SidebarSkillToggleRequest: Encodable {
    let enabled: Bool
}

private struct SidebarConnection: Decodable, Identifiable {
    let connectedAccountId: String
    let toolkitSlug: String
    let toolkitName: String
    let logoUrl: String?
    let status: String

    var id: String { connectedAccountId }
    var displayToolkitName: String { sidebarDisplayToolkitName(toolkitName) }
}

private struct SidebarConnectionRow: View {
    let connection: SidebarConnection
    let theme: ConductorThemePalette
    let onDisconnect: () -> Void

    @State private var isHovered = false

    private var disconnectText: Color {
        theme.dangerSoft
    }

    // A live connection reads ink-faint; anything not active/connected
    // (needs-auth, failed, expired, …) reads as the editorial orange warn.
    private var isHealthy: Bool {
        ["active", "connected"].contains(connection.status.lowercased())
    }

    private var statusColor: Color {
        isHealthy ? theme.inkFaint : theme.orange
    }

    var body: some View {
        HStack(spacing: 10) {
            ConnectionLogo(
                logoUrl: connection.logoUrl,
                toolkitName: connection.displayToolkitName,
                theme: theme
            )

            Text(connection.displayToolkitName)
                .font(ConductorType.rowTitle)
                .foregroundStyle(isHovered ? theme.ink : theme.ink2)

            Spacer(minLength: 0)

            if isHovered {
                Button(action: onDisconnect) {
                    Text("Disconnect")
                        .font(ConductorType.caption)
                        .foregroundStyle(disconnectText)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Revoke access and remove this connection")
            } else if !isHealthy {
                Text(connection.status.capitalized)
                    .font(ConductorType.meta)
                    .foregroundStyle(statusColor)
            }
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
    }
}

private struct SidebarCustomConnector: Decodable, Identifiable {
    let id: String
    let name: String
    let slug: String
    let url: String
    let transport: String
    let auth: String
    var logoUrl: String?
    let status: SidebarCustomConnectorStatus

    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? slug : trimmed
    }

    var statusText: String {
        switch status.state {
        case "connected":
            let count = status.toolCount ?? 0
            return count > 0 ? "\(count) tool\(count == 1 ? "" : "s")" : "Connected"
        case "pending_auth":
            return "Waiting for sign-in"
        default:
            return status.reason ?? "No tools registered"
        }
    }
}

private struct SidebarCustomConnectorStatus: Decodable {
    let state: String
    let toolCount: Int?
    let reason: String?
    let cached: Bool?
}

private struct SidebarCustomConnectorRow: View {
    let connector: SidebarCustomConnector
    let theme: ConductorThemePalette
    let onRetry: () -> Void
    let onDisconnect: () -> Void

    @State private var isHovered = false

    private var isHealthy: Bool {
        connector.status.state == "connected"
    }

    var body: some View {
        HStack(spacing: 10) {
            ConnectionLogo(
                logoUrl: connector.logoUrl,
                toolkitName: connector.displayName,
                theme: theme
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(connector.displayName)
                    .font(ConductorType.rowTitle)
                    .foregroundStyle(isHovered ? theme.ink : theme.ink2)
                    .lineLimit(1)
                Text(connector.statusText)
                    .font(ConductorType.meta)
                    .foregroundStyle(isHealthy ? theme.inkFaint : theme.orange)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if isHovered {
                Button(action: onDisconnect) {
                    Text("Disconnect")
                        .font(ConductorType.caption)
                        .foregroundStyle(theme.dangerSoft)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Disconnect and remove this custom connector")
            }
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
        .contextMenu {
            if !isHealthy {
                Button("Sign in again", action: onRetry)
            }
            Button("Disconnect", role: .destructive, action: onDisconnect)
        }
    }
}

private struct ConnectionLogo: View {
    let logoUrl: String?
    let toolkitName: String
    let theme: ConductorThemePalette

    @State private var image: NSImage?

    private static let size: CGFloat = 16

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                fallback
            }
        }
        .frame(width: Self.size, height: Self.size)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .task(id: logoUrl) {
            await loadImage()
        }
    }

    private var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(theme.iconFallbackFill)
            Text(String(toolkitName.prefix(1)).uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(theme.iconFallbackText)
        }
    }

    private func loadImage() async {
        image = nil
        guard let logoUrl, let url = URL(string: logoUrl) else {
            return
        }
        if let cached = ConnectionLogoCache.shared.image(for: logoUrl) {
            image = cached
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard !Task.isCancelled else { return }
            if let httpResponse = response as? HTTPURLResponse {
                guard (200..<300).contains(httpResponse.statusCode) else { return }
            }
            if let nsImage = NSImage(data: data) {
                ConnectionLogoCache.shared.set(nsImage, for: logoUrl)
                image = nsImage
            }
        } catch {
            // Fallback view will render on failure.
        }
    }
}

private func sidebarDisplayToolkitName(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = trimmed.lowercased().replacingOccurrences(of: "_", with: " ")
    switch normalized {
    case "google calendar", "googlecalendar":
        return "Calendar"
    case "google docs", "googledocs":
        return "Docs"
    case "google drive", "googledrive":
        return "Drive"
    case "google sheets", "googlesheets":
        return "Sheets"
    case "granola mcp":
        return "Granola"
    default:
        if normalized.hasPrefix("google ") {
            return String(trimmed.dropFirst("Google ".count))
        }
        if normalized.hasSuffix(" mcp") {
            return String(trimmed.dropLast(" MCP".count))
        }
        return trimmed.isEmpty ? name : trimmed
    }
}

private final class ConnectionLogoCache {
    static let shared = ConnectionLogoCache()

    private let cache = NSCache<NSString, NSImage>()

    func image(for key: String) -> NSImage? {
        cache.object(forKey: key as NSString)
    }

    func set(_ image: NSImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }
}

private struct SidebarConnectionsResponse: Decodable {
    let connections: [SidebarConnection]
}

private struct SidebarCustomConnectorsResponse: Decodable {
    let connectors: [SidebarCustomConnector]
}

private struct SidebarCustomConnectorResponse: Decodable {
    let connector: SidebarCustomConnector
}

// Internal (not `private`) so the shell-protocol types in ChatWebView.swift
// can carry `[SidebarChatSession]` inside `ShellState`.
struct SidebarChatSession: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
    let model: String?
    let messageCount: Int
    let lastMessagePreview: String?
}

private struct SidebarChatSessionsResponse: Decodable {
    let sessions: [SidebarChatSession]
}

private struct SidebarChatSessionEnvelope: Decodable {
    let session: SidebarChatSession
}

private struct SidebarRenameSessionRequest: Encodable {
    let title: String
}

private struct SidebarToast: Identifiable, Equatable {
    let id: UUID
    let message: String
}

private enum SidebarRequestError: LocalizedError {
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The sidecar returned an invalid response."
        }
    }
}

private func replacing(_ session: SidebarChatSession, in sessions: [SidebarChatSession]) -> [SidebarChatSession] {
    let filtered = sessions.filter { $0.id != session.id }
    return [session] + filtered
}

private func sortSessions(_ sessions: [SidebarChatSession]) -> [SidebarChatSession] {
    sessions.sorted { left, right in
        if (left.archivedAt == nil) != (right.archivedAt == nil) {
            return left.archivedAt == nil
        }

        let leftKey = left.archivedAt ?? left.updatedAt
        let rightKey = right.archivedAt ?? right.updatedAt
        return leftKey > rightKey
    }
}

private func sessionTimestampLabel(_ session: SidebarChatSession) -> String {
    let source = session.archivedAt ?? session.updatedAt
    guard let date = sidebarISO8601WithFractional.date(from: source) ?? sidebarISO8601.date(from: source) else { return "" }
    return compactRelativeAge(from: date)
}

/// Single-unit compact age used in the `.sess` trailing column: `3s`, `3m`,
/// `26m`, `20h`, `3w`, then `mo` / `y` for older sessions.
private func compactRelativeAge(from date: Date) -> String {
    let seconds = Int(max(0, Date().timeIntervalSince(date)))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    if days < 7 { return "\(days)d" }
    let weeks = days / 7
    if weeks < 5 { return "\(weeks)w" }
    let months = days / 30
    if days < 365 { return "\(months)mo" }
    return "\(days / 365)y"
}

private let sidebarISO8601WithFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let sidebarISO8601: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

private struct SidebarToastView: View {
    let toast: SidebarToast
    let theme: ConductorThemePalette
    let isDarkMode: Bool

    var body: some View {
        Text(toast.message)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(theme.toastText)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .fill(theme.toastFill)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .stroke(theme.toastStroke, lineWidth: 1)
            }
            .shadow(color: .black.opacity(isDarkMode ? 0.18 : 0.08), radius: 12, y: 4)
    }
}

private struct RenameTextField: NSViewRepresentable {
    @Binding var text: String
    let isDarkMode: Bool
    let onCommit: () -> Void
    let onCancel: () -> Void

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: text)
        field.delegate = context.coordinator
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        // Blend with the row: transparent field, IBM Plex Sans 13 to match the
        // `.sess` title it replaces.
        field.font = NSFont(name: "IBM Plex Sans", size: 13) ?? .systemFont(ofSize: 13, weight: .regular)
        field.textColor = isDarkMode
            ? NSColor.white.withAlphaComponent(0.90)
            : NSColor(red: 52/255, green: 51/255, blue: 45/255, alpha: 1)  // #34332D ink
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.cell?.lineBreakMode = .byTruncatingTail

        // Take first responder once the view is in a window. The chat WKWebView
        // frequently holds first responder, so we have to claim it directly via
        // AppKit — SwiftUI's @FocusState doesn't always pre-empt the WebView.
        DispatchQueue.main.async {
            guard let window = field.window else { return }
            window.makeFirstResponder(field)
            field.currentEditor()?.selectAll(nil)
        }

        return field
    }

    func updateNSView(_ nsView: NSTextField, context: Context) {
        context.coordinator.parent = self
        if nsView.stringValue != text {
            nsView.stringValue = text
        }
        nsView.textColor = isDarkMode
            ? NSColor.white.withAlphaComponent(0.90)
            : NSColor(red: 52/255, green: 51/255, blue: 45/255, alpha: 1)  // #34332D ink
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: RenameTextField
        private var hasResolved = false

        init(parent: RenameTextField) {
            self.parent = parent
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
        }

        func control(
            _ control: NSControl,
            textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                resolve(commit: true)
                return true
            }
            if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                resolve(commit: false)
                return true
            }
            return false
        }

        func controlTextDidEndEditing(_ notification: Notification) {
            // Commit on losing focus too (clicking elsewhere).
            resolve(commit: true)
        }

        private func resolve(commit: Bool) {
            guard !hasResolved else { return }
            hasResolved = true
            if commit {
                parent.onCommit()
            } else {
                parent.onCancel()
            }
        }
    }
}

private struct SidebarVisualEffect: NSViewRepresentable {
    let isDarkMode: Bool

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.state = .active
        view.blendingMode = .behindWindow
        view.material = isDarkMode ? .hudWindow : .sidebar
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.state = .active
        nsView.blendingMode = .behindWindow
        nsView.material = isDarkMode ? .hudWindow : .sidebar
    }
}


// MARK: - Window Control Button

enum WindowAction {
    case close, miniaturize, zoom
}

private struct TopChromeControls: View {
    @Binding var isLeftSidebarExpanded: Bool
    let iconColor: Color
    let ringColor: Color

    var body: some View {
        HStack(spacing: 8) {
            WindowControlButton(color: Color(red: 1.0, green: 95/255, blue: 87/255), action: .close, ringColor: ringColor)
            WindowControlButton(color: Color(red: 254/255, green: 188/255, blue: 46/255), action: .miniaturize, ringColor: ringColor)
            WindowControlButton(color: Color(red: 40/255, green: 200/255, blue: 64/255), action: .zoom, ringColor: ringColor)

            Button(action: { isLeftSidebarExpanded.toggle() }) {
                SidebarToggleIcon(side: .left, color: iconColor.opacity(0.82))
                    .frame(width: 18, height: 14)
                    .padding(3)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 8)

            Spacer()
        }
    }
}

private enum SidebarToggleSide {
    case left
    case right
}

private struct SidebarToggleIcon: View {
    let side: SidebarToggleSide
    let color: Color

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                .stroke(color, lineWidth: 1.25)

            Rectangle()
                .fill(color)
                .frame(width: 1.0)
                .offset(x: side == .left ? -2.0 : 2.0)
        }
        .frame(width: 13, height: 12)
    }
}

struct WindowControlButton: View {
    let color: Color
    let action: WindowAction
    // When set, render the editorial titlebar size while keeping the macOS
    // traffic-light color language. When nil (e.g. the sign-in screen), keep
    // the slightly larger classic look.
    var ringColor: Color? = nil
    @State private var isHovered = false

    private var isEditorial: Bool { ringColor != nil }
    private var diameter: CGFloat { isEditorial ? 12 : 14 }

    private var fillColor: Color {
        if isEditorial {
            return isHovered ? color : color.opacity(0.92)
        }
        return isHovered ? color : color.opacity(0.9)
    }

    private var borderColor: Color {
        isEditorial ? .black.opacity(0.14) : .black.opacity(0.10)
    }

    var body: some View {
        Circle()
            .fill(fillColor)
            .frame(width: diameter, height: diameter)
            .overlay {
                Circle().strokeBorder(borderColor, lineWidth: 0.5)
                if isHovered {
                    Image(systemName: iconName)
                        .font(ConductorType.trafficGlyph)
                        .foregroundStyle(.black.opacity(0.55))
                }
            }
            .onHover { isHovered = $0 }
            .onTapGesture {
                guard let window = NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow ?? NSApplication.shared.windows.first else { return }
                switch action {
                case .close:
                    window.close()
                    // If this was the last window, quit the app
                    if NSApplication.shared.windows.filter({ $0.isVisible }).isEmpty {
                        NSApplication.shared.terminate(nil)
                    }
                case .miniaturize: window.miniaturize(nil)
                case .zoom: window.zoom(nil)
                }
            }
    }

    private var iconName: String {
        switch action {
        case .close: return "xmark"
        case .miniaturize: return "minus"
        case .zoom: return "plus"
        }
    }
}

/// Footer `.toggles a`: an 11pt text link, dim normally, primary ink on hover.
private struct FooterTextToggle: View {
    let label: String
    let theme: ConductorThemePalette
    let action: () -> Void
    var help: String = ""
    var isEmphasized = false
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(isEmphasized ? ConductorType.captionStrong : ConductorType.caption)
                .foregroundStyle(textColor)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
    }

    private var textColor: Color {
        if isHovered { return theme.ink }
        return isEmphasized ? theme.ink2 : theme.footerIcon
    }
}

/// Footer `.toggles .sep`: the ink-faint `·` between text toggles.
private struct FooterSeparator: View {
    let theme: ConductorThemePalette

    var body: some View {
        Text("·")
            .font(ConductorType.caption)
            .foregroundStyle(theme.inkFaint)
    }
}

private struct SidebarFooter: View {
    @Binding var isDarkMode: Bool
    let sidecarState: SidecarManager.State
    let theme: ConductorThemePalette
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.footerDivider)
                .frame(height: 1)

            ZStack(alignment: .topLeading) {
                Circle()
                    .fill(sidecarStatusColor)
                    .frame(width: 7, height: 7)
                    .padding(.leading, 24)
                    .padding(.top, 12)
                    .help(sidecarStatusText)

                HStack(spacing: 8) {
                    Spacer(minLength: 8)

                    // Text toggles replace the moon/gear/help icon buttons; label
                    // shows the mode you'd switch TO (`dark` in light, `light` in dark).
                    FooterTextToggle(label: isDarkMode ? "light" : "dark", theme: theme, action: { isDarkMode.toggle() })
                    FooterSeparator(theme: theme)
                    FooterTextToggle(label: "settings", theme: theme, action: onOpenSettings, help: "Settings")
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 10)
            }
        }
    }

    private var sidecarStatusColor: Color {
        switch sidecarState {
        case .idle: return .gray
        case .starting: return .yellow
        case .running: return theme.green
        case .failed: return .red
        }
    }

    private var sidecarStatusText: String {
        switch sidecarState {
        case .idle: return "Offline"
        case .starting: return "Connecting"
        case .running: return "Connected"
        case .failed: return "Connection error"
        }
    }
}


#if DEBUG
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(sidecar: SidecarManager(), managedSessionStore: ManagedSessionStore())
            .frame(width: 1200, height: 750)
            .preferredColorScheme(.dark)
    }
}
#endif
