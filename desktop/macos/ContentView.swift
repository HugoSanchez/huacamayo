import SwiftUI
import AppKit
import Combine

private struct SidebarLoadIdentity: Hashable {
    let sidecarPort: Int?
    let userId: String?
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
    @State private var hasLoadedInitialSidebarData = false
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

    private var sidebarLoadIdentity: SidebarLoadIdentity {
        SidebarLoadIdentity(
            sidecarPort: sidecarPort,
            userId: managedSessionStore.currentSession?.userId
        )
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
                        isBootstrapping: !hasLoadedInitialSidebarData,
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
        .task(id: sidebarLoadIdentity) {
            await loadInitialSidebarData()
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
    private func loadInitialSidebarData() async {
        guard sidecar.baseURL != nil else { return }

        await refreshSessions()
        await refreshConnections()
        await refreshSkills()
        await refreshCrons()

        guard !Task.isCancelled else { return }
        hasLoadedInitialSidebarData = true
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
        defer { isLoadingSessions = false }

        do {
            let url = baseURL.appendingPathComponent("chat/sessions")
            let decoded = try await decodeSidecarResponse(
                SidebarChatSessionsResponse.self,
                from: sidecarRequest(url: url)
            )
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
            guard !isCancellation(error) else { return }
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "load-sessions")
        }
    }

    private func isCancellation(_ error: Error) -> Bool {
        if Task.isCancelled || error is CancellationError {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    private func sidecarRequest(
        url: URL,
        method: String = "GET",
        body: Data? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        applySidecarAuthHeader(&request)
        return request
    }

    private func sidecarData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode) else {
            throw SidebarRequestError.invalidResponse
        }
        return data
    }

    private func decodeSidecarResponse<T: Decodable>(
        _ type: T.Type,
        from request: URLRequest
    ) async throws -> T {
        let data = try await sidecarData(for: request)
        return try JSONDecoder().decode(type, from: data)
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
            let decoded = try await decodeSidecarResponse(
                SidebarConnectionsResponse.self,
                from: sidecarRequest(url: url)
            )
            connections = decoded.connections
        } catch {
            // Keep the last known list when refresh fails.
        }

        do {
            let url = baseURL.appendingPathComponent("connectors/custom")
            let decoded = try await decodeSidecarResponse(
                SidebarCustomConnectorsResponse.self,
                from: sidecarRequest(url: url)
            )
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
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("connections/\(connectedAccountId)"),
                method: "DELETE"
            )
            _ = try await sidecarData(for: request)
        } catch {
            connections = original
        }
        await refreshConnections()
    }

    @MainActor
    private func retryCustomConnector(_ connectorId: String) async {
        guard let baseURL = sidecar.baseURL else { return }
        do {
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("connectors/custom/\(connectorId)/retry"),
                method: "POST"
            )
            let decoded = try await decodeSidecarResponse(SidebarCustomConnectorResponse.self, from: request)
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
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("connectors/custom/\(connectorId)"),
                method: "DELETE"
            )
            _ = try await sidecarData(for: request)
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
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("crons/\(id)"),
                method: "DELETE"
            )
            _ = try await sidecarData(for: request)
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
            let decoded = try await decodeSidecarResponse(
                SidebarCronsResponse.self,
                from: sidecarRequest(url: url)
            )
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
            let decoded = try await decodeSidecarResponse(
                SidebarSkillsResponse.self,
                from: sidecarRequest(url: url)
            )
            skills = decoded.skills
        } catch {
            // Keep the last known list when refresh fails.
        }
    }

    @MainActor
    private func toggleSkill(_ slug: String, enabled: Bool) async {
        guard let baseURL = sidecar.baseURL else { return }
        do {
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("skills/\(slug)/toggle"),
                method: "POST",
                body: try JSONEncoder().encode(SidebarSkillToggleRequest(enabled: enabled))
            )
            _ = try await sidecarData(for: request)
            await refreshSkills()
        } catch {
            // Best-effort; fall back to next refresh tick.
        }
    }

    @MainActor
    private func createSession() async {
        guard let baseURL = sidecar.baseURL else { return }

        do {
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("chat/sessions"),
                method: "POST",
                body: Data("{}".utf8)
            )
            let decoded = try await decodeSidecarResponse(SidebarChatSessionEnvelope.self, from: request)
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
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("chat/sessions/\(sessionId)/archive"),
                method: "POST"
            )
            let decoded = try await decodeSidecarResponse(SidebarChatSessionEnvelope.self, from: request)
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
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("chat/sessions/\(sessionId)/rename"),
                method: "POST",
                body: try JSONEncoder().encode(SidebarRenameSessionRequest(title: title))
            )
            let decoded = try await decodeSidecarResponse(SidebarChatSessionEnvelope.self, from: request)
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
            let request = sidecarRequest(
                url: baseURL.appendingPathComponent("chat/sessions/\(sessionId)/unarchive"),
                method: "POST"
            )
            let decoded = try await decodeSidecarResponse(SidebarChatSessionEnvelope.self, from: request)
            sessions = sortSessions(replacing(decoded.session, in: sessions))
            setSelectedSession(decoded.session.id)
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
            Telemetry.reportError(error, context: "resume-archived-session")
        }
    }

    /// Single entry point for every product-level JS→Swift action.
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
        case .createSession:
            Task { await createSession() }
        case .archiveSession(let id):
            Task { await archiveSession(id) }
        case .unarchiveSession(let id):
            Task { await resumeArchivedSession(id) }
        case .renameSession(let id, let title):
            Task { await renameSession(id, title: title) }
        case .cronsChanged:
            Task { await refreshCrons() }
        case .connectionsChanged:
            Task { await refreshConnections() }
        case .skillsChanged:
            Task { await refreshSkills() }
        case .openExternalUrl(let rawURL):
            if let url = URL(string: rawURL) {
                NSWorkspace.shared.open(url)
            }
        case .signOut:
            managedSessionStore.clearSession()
        case .catalogClosed:
            isConnectionsCatalogExpanded = false
        case .skillsCatalogClosed:
            isSkillsCatalogExpanded = false
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
        hasLoadedInitialSidebarData = false
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

#if DEBUG
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(sidecar: SidecarManager(), managedSessionStore: ManagedSessionStore())
            .frame(width: 1200, height: 750)
            .preferredColorScheme(.dark)
    }
}
#endif
