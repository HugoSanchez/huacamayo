import SwiftUI
import AppKit

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
    @AppStorage("isDarkMode") private var isDarkMode = true
    @AppStorage("isLeftSidebarExpanded") private var isLeftSidebarExpanded = true
    @AppStorage("isRightSidebarExpanded") private var isRightSidebarExpanded = true
    @AppStorage("isConnectionsCatalogExpanded") private var isConnectionsCatalogExpanded = false
    @AppStorage("selectedChatSessionId") private var persistedSelectedSessionId = ""
    @State private var sessions: [SidebarChatSession] = []
    @State private var selectedSessionId: String?
    @State private var isLoadingSessions = false
    @State private var sessionError: String?
    @State private var sidebarToast: SidebarToast?
    @State private var connections: [SidebarConnection] = []
    private let sidebarRefreshTimer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    init(sidecar: SidecarManager) {
        self.sidecar = sidecar
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
                        isLoadingSessions: isLoadingSessions,
                        sessionError: sessionError,
                        sidecarReady: sidecarPort != nil,
                        connections: connections,
                        isCatalogOpen: isConnectionsCatalogExpanded,
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
                        }
                    )
                }

                Spacer(minLength: 0)

                if isLeftSidebarExpanded {
                    SidebarFooter(isDarkMode: $isDarkMode, sidecarState: sidecar.state, theme: theme)
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
                selectedSessionId: selectedSessionId,
                isDarkMode: isDarkMode,
                isCatalogOpen: isConnectionsCatalogExpanded,
                onSessionStateChange: handleWebSessionStateChange,
                onCatalogStateChange: { open in
                    isConnectionsCatalogExpanded = open
                }
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
        .task(id: sidecarPort) {
            await refreshSessions()
            await refreshConnections()
        }
        .onReceive(sidebarRefreshTimer) { _ in
            guard sidecarPort != nil else { return }
            Task {
                await refreshSessions()
                await refreshConnections()
            }
        }
    }

    @MainActor
    private func refreshSessions(preferredSelection: String? = nil) async {
        guard let baseURL = sidecar.baseURL else {
            sessions = []
            setSelectedSession(nil)
            sessionError = nil
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
            setSelectedSession(resolveSelectedSessionId(in: nextSessions, preferredSelection: preferredSelection))
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
        }

        isLoadingSessions = false
    }

    @MainActor
    private func refreshConnections() async {
        guard let baseURL = sidecar.baseURL else {
            connections = []
            return
        }

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
                setSelectedSession(resolveSelectedSessionId(in: nextSessions, preferredSelection: nil))
            }
            sessionError = nil
            showSidebarToast("Session archived")
        } catch {
            sessionError = error.localizedDescription
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
        }
    }

    @MainActor
    private func handleWebSessionStateChange(_ sessionId: String?) {
        setSelectedSession(sessionId)
        Task {
            await refreshSessions(preferredSelection: sessionId)
        }
    }

    @MainActor
    private func selectSession(_ sessionId: String) {
        guard selectedSessionId != sessionId else { return }
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

        return sessions.first(where: { $0.archivedAt == nil })?.id ?? sessions.first?.id
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
    let isLoadingSessions: Bool
    let sessionError: String?
    let sidecarReady: Bool
    let connections: [SidebarConnection]
    let isCatalogOpen: Bool
    let onCreateSession: () -> Void
    let onArchiveSession: (String) -> Void
    let onRenameSession: (String, String) -> Void
    let onSelectSession: (String) -> Void
    let onToggleCatalog: () -> Void

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

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button(action: onCreateSession) {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                    Text("New Session")
                        .font(.system(size: 13, weight: .medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(primaryText)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.clear)
            }
            .buttonStyle(.plain)
            .disabled(!sidecarReady)

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
                    SessionSidebarSection(
                        title: "SESSIONS",
                        emptyText: sidecarReady ? "No sessions yet." : "Sessions will appear once the sidecar is ready.",
                        sessions: activeSessions,
                        selectedSessionId: selectedSessionId,
                        isDarkMode: isDarkMode,
                        renamingSessionId: renamingSessionId,
                        draftTitle: draftTitle,
                        onDraftTitleChange: { draftTitle = $0 },
                        onSelectSession: onSelectSession,
                        onArchiveSession: onArchiveSession,
                        onBeginRename: beginRename,
                        onCommitRename: commitRename
                    )

                    VStack(alignment: .leading, spacing: 8) {
                        Button(action: onToggleCatalog) {
                            HStack(spacing: 6) {
                                Text("CONNECTIONS")
                                    .font(.system(size: 11, weight: .semibold))
                                    .tracking(0.8)
                                    .foregroundStyle(secondaryText)
                                Image(systemName: isCatalogOpen ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 8, weight: .semibold))
                                    .foregroundStyle(secondaryText)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!sidecarReady)

                        if connections.isEmpty {
                            Text("No connected tools")
                                .font(.system(size: 12))
                                .foregroundStyle(secondaryText)
                                .padding(.horizontal, 10)
                        } else {
                            ForEach(connections) { connection in
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

                                    Text(connection.status.capitalized)
                                        .font(.system(size: 11))
                                        .foregroundStyle(secondaryText)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
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
        guard !trimmed.isEmpty, trimmed != session.title else { return }
        onRenameSession(session.id, trimmed)
    }
}

private struct SessionSidebarSection: View {
    let title: String?
    let emptyText: String
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
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

private struct SidebarConnection: Decodable, Identifiable {
    let connectedAccountId: String
    let toolkitSlug: String
    let toolkitName: String
    let logoUrl: String?
    let status: String

    var id: String { connectedAccountId }
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
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .task(id: logoUrl) {
            await loadImage()
        }
    }

    private var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
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

private struct SidebarChatSession: Decodable, Identifiable, Equatable {
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
                .frame(width: 1.25)
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
            .fill(isHovered ? color : color.opacity(0.85))
            .frame(width: 12, height: 12)
            .overlay {
                if isHovered {
                    Image(systemName: iconName)
                        .font(.system(size: 6, weight: .bold))
                        .foregroundStyle(.black.opacity(0.5))
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
    let theme: ConductorThemePalette

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.footerDivider)
                .frame(height: 1)

            HStack(spacing: 14) {
                // Sidecar status dot
                HStack(spacing: 6) {
                    Circle()
                        .fill(sidecarStatusColor)
                        .frame(width: 7, height: 7)
                    Text(sidecarStatusText)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.footerIcon)
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

                Button(action: {}) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.footerIcon)
                }
                .buttonStyle(.plain)
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

}


#if DEBUG
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(sidecar: SidecarManager())
            .frame(width: 1200, height: 750)
            .preferredColorScheme(.dark)
    }
}
#endif
