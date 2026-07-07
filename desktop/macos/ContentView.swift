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

    static let windowCornerRadius: CGFloat = 10
}

private enum ConductorThemes {
    static let dark = ConductorThemePalette(
        sidebarTop: Color(red: 38/255, green: 47/255, blue: 45/255),      // #262F2D
        sidebarBottom: Color(red: 34/255, green: 47/255, blue: 55/255),   // #222F37
        sidebarTintOpacity: 0.94,
        mainCanvas: Color(red: 20/255, green: 22/255, blue: 24/255),      // #141618
        inputFill: Color(red: 37/255, green: 40/255, blue: 43/255),       // #25282B
        inputStroke: Color.white.opacity(0.10),
        rightTop: Color(red: 19/255, green: 21/255, blue: 23/255),        // #131517
        rightBottom: Color(red: 19/255, green: 21/255, blue: 23/255),     // #131517
        verticalDivider: Color(red: 42/255, green: 45/255, blue: 48/255), // #2A2D30
        horizontalDivider: Color(red: 42/255, green: 45/255, blue: 48/255), // #2A2D30
        rightDividerThickness: 1,
        centerRightDividerThickness: 1,
        headerTopStart: Color(red: 43/255, green: 43/255, blue: 42/255, opacity: 0.52),
        headerTopEnd: Color(red: 33/255, green: 33/255, blue: 32/255, opacity: 0.52),
        headerTabsStart: Color(red: 41/255, green: 41/255, blue: 40/255, opacity: 0.48),
        headerTabsEnd: Color(red: 30/255, green: 30/255, blue: 29/255, opacity: 0.48),
        headerDivider: Color.white.opacity(0.10),
        headerBottomDivider: Color.white.opacity(0.10),
        headerBottomDividerThickness: 1,
        headerActiveLine: Color.white.opacity(0.65),
        footerDivider: Color.white.opacity(0.10),
        footerIcon: Color.white.opacity(0.52),
        windowBorder: Color.white.opacity(0.08)
    )

    // Light mode equivalent that preserves the same panel hierarchy and contrast steps.
    static let light = ConductorThemePalette(
        sidebarTop: Color(red: 236/255, green: 242/255, blue: 246/255),      // #ECF2F6
        sidebarBottom: Color(red: 227/255, green: 235/255, blue: 241/255),   // #E3EBF1
        sidebarTintOpacity: 0.46,
        mainCanvas: Color(red: 243/255, green: 245/255, blue: 247/255),      // #F3F5F7
        inputFill: Color(red: 235/255, green: 238/255, blue: 242/255),       // #EBEEF2
        inputStroke: Color.black.opacity(0.10),
        rightTop: Color(red: 241/255, green: 244/255, blue: 247/255),        // #F1F4F7
        rightBottom: Color(red: 241/255, green: 244/255, blue: 247/255),     // #F1F4F7
        verticalDivider: Color(red: 214/255, green: 220/255, blue: 226/255), // #D6DCE2
        horizontalDivider: Color(red: 214/255, green: 220/255, blue: 226/255), // #D6DCE2
        rightDividerThickness: 0.5,
        centerRightDividerThickness: 0,
        headerTopStart: Color(red: 250/255, green: 251/255, blue: 253/255, opacity: 0.26),
        headerTopEnd: Color(red: 239/255, green: 243/255, blue: 247/255, opacity: 0.26),
        headerTabsStart: Color(red: 248/255, green: 250/255, blue: 252/255, opacity: 0.22),
        headerTabsEnd: Color(red: 236/255, green: 241/255, blue: 246/255, opacity: 0.22),
        headerDivider: Color.black.opacity(0.12),
        headerBottomDivider: Color.black.opacity(0.06),
        headerBottomDividerThickness: 0.5,
        headerActiveLine: Color.black.opacity(0.55),
        footerDivider: Color.black.opacity(0.10),
        footerIcon: Color.black.opacity(0.52),
        windowBorder: Color.black.opacity(0.10)
    )
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
                        iconColor: theme.footerIcon
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
                        },
                        onToggleSkillsCatalog: {
                            isSkillsCatalogExpanded.toggle()
                        },
                        onOpenCron: { cronId in
                            pendingCronOpen = CronOpenRequest(id: cronId, token: UUID())
                        },
                        onDeleteCron: { cronId in
                            Task { await deleteCron(cronId) }
                        },
                        onDisconnectConnection: { connectedAccountId in
                            Task { await disconnectConnection(connectedAccountId) }
                        }
                    )
                }

                Spacer(minLength: 0)

                if isLeftSidebarExpanded {
                    SidebarFooter(
                        isDarkMode: $isDarkMode,
                        sidecarState: sidecar.state,
                        managedAccount: sidecar.managedAccount,
                        managedSession: managedSessionStore.currentSession,
                        theme: theme,
                        onSignOut: { managedSessionStore.clearSession() },
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
                    SidebarToastView(toast: sidebarToast, isDarkMode: isDarkMode)
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
                        iconColor: theme.footerIcon
                    )
                    .padding(.leading, 14)
                    .padding(.top, 14)
                }
            }
            .overlay(alignment: .topTrailing) {
                Button(action: { isRightSidebarExpanded.toggle() }) {
                    SidebarToggleIcon(side: .right, color: theme.footerIcon.opacity(0.82))
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
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw SidebarRequestError.invalidResponse
            }

            let decoded = try JSONDecoder().decode(SidebarChatSessionsResponse.self, from: data)
            let nextSessions = sortSessions(decoded.sessions)
            sessions = nextSessions

            let resolved = resolveSelectedSessionId(in: nextSessions, preferredSelection: preferredSelection)
            if resolved != nil {
                setSelectedSession(resolved)
            } else if !hasCompletedInitialSelection {
                let fallback = nextSessions.first(where: { $0.archivedAt == nil })?.id
                    ?? nextSessions.first?.id
                setSelectedSession(fallback)
            }
            hasCompletedInitialSelection = true
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "load-sessions")
        }

        isLoadingSessions = false
    }

    @MainActor
    private func refreshConnections() async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            let url = baseURL.appendingPathComponent("connections")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return
            }

            let decoded = try JSONDecoder().decode(SidebarConnectionsResponse.self, from: data)
            connections = decoded.connections
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
    private func deleteCron(_ id: String) async {
        guard let baseURL = sidecar.baseURL else { return }
        let original = crons
        // Optimistic: remove from sidebar immediately so the row dismiss
        // feels instant. If the server rejects, restore on next refresh.
        crons.removeAll { $0.id == id }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("crons/\(id)"))
            request.httpMethod = "DELETE"
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
            let (data, response) = try await URLSession.shared.data(from: url)
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
            let (data, response) = try await URLSession.shared.data(from: url)
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
            persistedSelectedSessionId.isEmpty ? nil : persistedSelectedSessionId,
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

    @State private var renamingSessionId: String?
    @State private var draftTitle = ""

    private var primaryText: Color {
        isDarkMode ? Color.white.opacity(0.86) : Color.black.opacity(0.72)
    }

    private var secondaryText: Color {
        isDarkMode ? Color.white.opacity(0.44) : Color.black.opacity(0.42)
    }

    private var activeSessions: [SidebarChatSession] {
        sessions.filter { $0.archivedAt == nil }
    }

    private func cronSubtitle(_ cron: SidebarCron) -> String? {
        if cron.state == "paused" { return "Disabled" }
        if let next = cron.nextRunAt, let date = parseISODate(next) {
            if date.timeIntervalSinceNow < 0 { return cron.scheduleDisplay }
            return "next " + relativeTime(date)
        }
        return cron.scheduleDisplay
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
                    .font(.system(size: 11))
                    .foregroundStyle(Color.red.opacity(isDarkMode ? 0.88 : 0.74))
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
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Button(action: {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    isSessionsExpanded.toggle()
                                }
                            }) {
                                HStack(spacing: 6) {
                                    Text("SESSIONS")
                                        .font(.system(size: 11, weight: .semibold))
                                        .tracking(0.8)
                                        .foregroundStyle(secondaryText)
                                    Image(systemName: isSessionsExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 8, weight: .semibold))
                                        .foregroundStyle(secondaryText)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Button(action: onCreateSession) {
                                Image(systemName: "plus")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(secondaryText)
                                    .frame(width: 18, height: 18)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(!sidecarReady)
                            .help("New session")
                        }

                        if isSessionsExpanded {
                            SessionSidebarSection(
                                title: nil,
                                emptyText: sidecarReady ? "No sessions yet." : "Sessions will appear once the sidecar is ready.",
                                sessions: activeSessions,
                                selectedSessionId: selectedSessionId,
                                streamingSessionIds: streamingSessionIds,
                                unreadSessionIds: unreadSessionIds,
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

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Button(action: {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    isConnectionsExpanded.toggle()
                                }
                            }) {
                                HStack(spacing: 6) {
                                    Text("CONNECTIONS")
                                        .font(.system(size: 11, weight: .semibold))
                                        .tracking(0.8)
                                        .foregroundStyle(secondaryText)
                                    Image(systemName: isConnectionsExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 8, weight: .semibold))
                                        .foregroundStyle(secondaryText)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Button(action: onToggleCatalog) {
                                Image(systemName: "plus")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(secondaryText)
                                    .frame(width: 18, height: 18)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(!sidecarReady)
                            .help("Browse connections")
                        }

                        if isConnectionsExpanded {
                            if connections.isEmpty {
                                Text("No connected tools")
                                    .font(.system(size: 12))
                                    .foregroundStyle(secondaryText)
                                    .padding(.horizontal, 10)
                            } else {
                                ForEach(connections) { connection in
                                    SidebarConnectionRow(
                                        connection: connection,
                                        primaryText: primaryText,
                                        secondaryText: secondaryText,
                                        isDarkMode: isDarkMode,
                                        onDisconnect: { onDisconnectConnection(connection.connectedAccountId) }
                                    )
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Button(action: {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    isSkillsExpanded.toggle()
                                }
                            }) {
                                HStack(spacing: 6) {
                                    Text("SKILLS")
                                        .font(.system(size: 11, weight: .semibold))
                                        .tracking(0.8)
                                        .foregroundStyle(secondaryText)
                                    Image(systemName: isSkillsExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 8, weight: .semibold))
                                        .foregroundStyle(secondaryText)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Button(action: onToggleSkillsCatalog) {
                                Image(systemName: "plus")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(secondaryText)
                                    .frame(width: 18, height: 18)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(!sidecarReady)
                            .help("Browse skills")
                        }

                        if isSkillsExpanded {
                            let pinnedSkills = skills.filter { $0.pinned }
                            if pinnedSkills.isEmpty {
                                Text("No skills pinned")
                                    .font(.system(size: 12))
                                    .foregroundStyle(secondaryText)
                                    .padding(.horizontal, 10)
                            } else {
                                ForEach(pinnedSkills) { skill in
                                    HStack(spacing: 10) {
                                        Image(systemName: "sparkles")
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundStyle(secondaryText)
                                            .frame(width: 18, height: 18)

                                        Text(skill.name)
                                            .font(.system(size: 13, weight: .regular))
                                            .foregroundStyle(primaryText)
                                            .lineLimit(1)

                                        Spacer(minLength: 0)

                                        Text("/" + skill.slug)
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(secondaryText)
                                            .lineLimit(1)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                isCronsExpanded.toggle()
                            }
                        }) {
                            HStack(spacing: 6) {
                                Text("ROUTINES")
                                    .font(.system(size: 11, weight: .semibold))
                                    .tracking(0.8)
                                    .foregroundStyle(secondaryText)
                                Image(systemName: isCronsExpanded ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 8, weight: .semibold))
                                    .foregroundStyle(secondaryText)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if isCronsExpanded {
                            if crons.isEmpty {
                                Text("No routines yet")
                                    .font(.system(size: 12))
                                    .foregroundStyle(secondaryText)
                                    .padding(.horizontal, 10)
                            } else {
                                ForEach(crons) { cron in
                                    SidebarCronRow(
                                        cron: cron,
                                        subtitle: cronSubtitle(cron),
                                        primaryText: primaryText,
                                        secondaryText: secondaryText,
                                        isDarkMode: isDarkMode,
                                        onOpen: { onOpenCron(cron.id) },
                                        onDelete: { onDeleteCron(cron.id) }
                                    )
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 22)
    }

    private var rowSelectionFill: Color {
        isDarkMode ? Color.white.opacity(0.07) : Color.white.opacity(0.72)
    }

    private var cardFill: Color {
        theme.inputFill.opacity(isDarkMode ? 0.38 : 0.82)
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

private struct SessionSidebarSection: View {
    let title: String?
    let emptyText: String
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
    let streamingSessionIds: Set<String>
    let unreadSessionIds: Set<String>
    let isDarkMode: Bool
    let renamingSessionId: String?
    let draftTitle: String
    let onDraftTitleChange: (String) -> Void
    let onSelectSession: (String) -> Void
    let onArchiveSession: ((String) -> Void)?
    let onBeginRename: (SidebarChatSession) -> Void
    let onCommitRename: (SidebarChatSession) -> Void

    private var primaryText: Color {
        isDarkMode ? Color.white.opacity(0.84) : Color.black.opacity(0.72)
    }

    private var secondaryText: Color {
        isDarkMode ? Color.white.opacity(0.44) : Color.black.opacity(0.42)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(secondaryText)
            }

            if sessions.isEmpty {
                Text(emptyText)
                    .font(.system(size: 12))
                    .foregroundStyle(secondaryText)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(sessions) { session in
                        SessionSidebarRow(
                            session: session,
                            isSelected: session.id == selectedSessionId,
                            isStreaming: streamingSessionIds.contains(session.id),
                            isUnread: unreadSessionIds.contains(session.id),
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
    let isSelected: Bool
    let isStreaming: Bool
    let isUnread: Bool
    let isDarkMode: Bool
    let isRenaming: Bool
    let draftTitle: String
    let onDraftTitleChange: (String) -> Void
    let onSelectSession: (String) -> Void
    let onArchiveSession: ((String) -> Void)?
    let onBeginRename: (SidebarChatSession) -> Void
    let onCommitRename: (SidebarChatSession) -> Void
    @State private var isHovered = false

    private var primaryText: Color {
        isDarkMode ? Color.white.opacity(0.88) : Color.black.opacity(0.76)
    }

    private var secondaryText: Color {
        isDarkMode ? Color.white.opacity(0.46) : Color.black.opacity(0.42)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
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
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(primaryText)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) {
                        onBeginRename(session)
                    }
            }

            Spacer(minLength: 0)

            if isHovered, !isRenaming {
                HStack(spacing: 2) {
                    Button(action: { onBeginRename(session) }) {
                        Image(systemName: "pencil")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(secondaryText)
                            .frame(width: 20, height: 20)
                    }
                    .buttonStyle(.plain)
                    .help("Rename session")

                    if let onArchiveSession, session.archivedAt == nil {
                        Button(action: { onArchiveSession(session.id) }) {
                            Image(systemName: "archivebox")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(secondaryText)
                                .frame(width: 20, height: 20)
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
                EqualizerBars(color: secondaryText)
                    .help("Agent is working")
            } else if isUnread, !isRenaming {
                // Unread response. Same slot as the working indicator so
                // the row width stays constant. Only one of {streaming,
                // unread} can be true at a time (unread fires *after* a
                // stream ends).
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 7, height: 7)
                    .help("New response")
            } else if !isRenaming {
                Text(sessionTimestampLabel(session))
                    .font(.system(size: 11))
                    .foregroundStyle(secondaryText)
            }
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .background(backgroundFill)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isRenaming else { return }
            onSelectSession(session.id)
        }
        .onHover { isHovered = $0 }
    }

    private var backgroundFill: Color {
        if isSelected {
            return isDarkMode ? Color.white.opacity(0.05) : Color.white.opacity(0.32)
        }
        if isHovered {
            return isDarkMode ? Color.white.opacity(0.03) : Color.white.opacity(0.18)
        }
        return .clear
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
    let subtitle: String?
    let primaryText: Color
    let secondaryText: Color
    let isDarkMode: Bool
    let onOpen: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false
    @State private var confirmingDelete = false
    @State private var confirmResetTask: Task<Void, Never>?

    private var isDisabled: Bool {
        cron.state == "paused"
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(cron.name)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(isDisabled ? secondaryText : primaryText)
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(secondaryText)
                            .opacity(isDisabled ? 0.86 : 1)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)

                if confirmingDelete {
                    Button(action: handleDeleteTap) {
                        Text("Confirm")
                            .font(.system(size: 11, weight: .regular))
                            .foregroundStyle(Color.red.opacity(isDarkMode ? 0.92 : 0.78))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Click to delete")
                } else if isHovered {
                    Button(action: handleDeleteTap) {
                        Image(systemName: "archivebox")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(secondaryText)
                            .frame(width: 18, height: 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete routine")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
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
}

private struct SidebarConnectionRow: View {
    let connection: SidebarConnection
    let primaryText: Color
    let secondaryText: Color
    let isDarkMode: Bool
    let onDisconnect: () -> Void

    @State private var isHovered = false

    private var disconnectText: Color {
        Color.red.opacity(isDarkMode ? 0.72 : 0.58)
    }

    var body: some View {
        HStack(spacing: 10) {
            ConnectionLogo(
                logoUrl: connection.logoUrl,
                toolkitName: connection.toolkitName,
                isDarkMode: isDarkMode
            )

            Text(connection.toolkitName)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(primaryText)

            Spacer(minLength: 0)

            if isHovered {
                Button(action: onDisconnect) {
                    Text("Disconnect")
                        .font(.system(size: 11))
                        .foregroundStyle(disconnectText)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Revoke access and remove this connection")
            } else {
                Text(connection.status.capitalized)
                    .font(.system(size: 11))
                    .foregroundStyle(secondaryText)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
    }
}

private struct ConnectionLogo: View {
    let logoUrl: String?
    let toolkitName: String
    let isDarkMode: Bool

    @State private var image: NSImage?

    private static let size: CGFloat = 18

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
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .task(id: logoUrl) {
            await loadImage()
        }
    }

    private var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isDarkMode ? Color.white.opacity(0.08) : Color.black.opacity(0.06))
            Text(String(toolkitName.prefix(1)).uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(isDarkMode ? Color.white.opacity(0.7) : Color.black.opacity(0.55))
        }
    }

    private func loadImage() async {
        guard let logoUrl, let url = URL(string: logoUrl) else {
            image = nil
            return
        }
        if let cached = ConnectionLogoCache.shared.image(for: logoUrl) {
            image = cached
            return
        }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard !Task.isCancelled else { return }
            if let nsImage = NSImage(data: data) {
                ConnectionLogoCache.shared.set(nsImage, for: logoUrl)
                image = nsImage
            }
        } catch {
            // Fallback view will render on failure.
        }
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

// Internal (not `private`) so the shell-protocol types in ChatWebView.swift
// can carry `[SidebarChatSession]` inside `ShellState`.
struct SidebarChatSession: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
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
    return sidebarRelativeFormatter.localizedString(for: date, relativeTo: Date())
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

private let sidebarRelativeFormatter: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter
}()

private struct SidebarToastView: View {
    let toast: SidebarToast
    let isDarkMode: Bool

    var body: some View {
        Text(toast.message)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(isDarkMode ? Color.white.opacity(0.88) : Color.black.opacity(0.78))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .fill(isDarkMode ? Color.black.opacity(0.42) : Color.white.opacity(0.82))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .stroke(isDarkMode ? Color.white.opacity(0.08) : Color.black.opacity(0.08), lineWidth: 1)
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
        field.font = .systemFont(ofSize: 13, weight: .regular)
        field.textColor = isDarkMode
            ? NSColor.white.withAlphaComponent(0.88)
            : NSColor.black.withAlphaComponent(0.76)
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
            ? NSColor.white.withAlphaComponent(0.88)
            : NSColor.black.withAlphaComponent(0.76)
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

    var body: some View {
        HStack(spacing: 8) {
            WindowControlButton(color: Color(red: 1.0, green: 0.38, blue: 0.35), action: .close)
            WindowControlButton(color: Color(red: 1.0, green: 0.78, blue: 0.24), action: .miniaturize)
            WindowControlButton(color: Color(red: 0.30, green: 0.85, blue: 0.39), action: .zoom)

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
    @State private var isHovered = false

    var body: some View {
        Circle()
            .fill(isHovered ? color : color.opacity(0.9))
            .frame(width: 14, height: 14)
            .overlay {
                if isHovered {
                    Image(systemName: iconName)
                        .font(.system(size: 8, weight: .bold))
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

private struct SidebarFooter: View {
    @Binding var isDarkMode: Bool
    let sidecarState: SidecarManager.State
    let managedAccount: SidecarManager.ManagedAccountSnapshot?
    let managedSession: ManagedAppSession?
    let theme: ConductorThemePalette
    let onSignOut: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.footerDivider)
                .frame(height: 1)

            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(sidecarStatusColor)
                            .frame(width: 7, height: 7)
                        Text(sidecarStatusText)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.footerIcon)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    Menu {
                        Button("Sign out", action: onSignOut)
                    } label: {
                        Text(managedSessionText)
                            .font(.system(size: 10))
                            .foregroundStyle(theme.footerIcon.opacity(0.84))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                }
                .padding(.leading, 16)

                Spacer()

                Button(action: { isDarkMode.toggle() }) {
                    Image(systemName: isDarkMode ? "sun.max" : "moon.fill")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.footerIcon)
                }
                .buttonStyle(.plain)

                Button(action: {}) {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.footerIcon)
                }
                .buttonStyle(.plain)

                Button(action: onOpenSettings) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.footerIcon)
                }
                .buttonStyle(.plain)
                .help("Settings")
            }
            .padding(.trailing, 16)
            .padding(.vertical, 10)
        }
    }

    private var sidecarStatusColor: Color {
        switch sidecarState {
        case .idle: return .gray
        case .starting: return .yellow
        case .running: return .green
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

    private var managedSessionText: String {
        if let managedAccount {
            switch managedAccount.account.state {
            case "authenticated":
                if let email = managedAccount.account.user?.email, !email.isEmpty {
                    return email
                }
                if let displayName = managedAccount.account.user?.displayName, !displayName.isEmpty {
                    return displayName
                }
                if let userId = managedAccount.account.user?.id, !userId.isEmpty {
                    return userId
                }
                return "Signed in"
            case "expired":
                return "Managed session expired"
            case "invalid_session":
                return "Sign-in expired"
            case "backend_unavailable":
                if let managedSession, !managedSession.isExpired {
                    return managedSession.identityLabel
                }
                return "Managed backend unavailable"
            case "signed_out":
                break
            default:
                break
            }
        }

        guard let managedSession else { return "Signed out" }
        if managedSession.isExpired {
            return "Managed session expired"
        }
        return managedSession.identityLabel
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
