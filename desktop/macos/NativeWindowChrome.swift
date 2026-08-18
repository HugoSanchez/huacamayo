import SwiftUI
import AppKit

// MARK: - Window Control Button

enum WindowAction {
    case close, miniaturize, zoom
}

struct TopChromeControls: View {
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

enum SidebarToggleSide {
    case left
    case right
}

struct SidebarToggleIcon: View {
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

struct SidebarFooter: View {
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
