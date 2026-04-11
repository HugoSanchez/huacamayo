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
    @AppStorage("isDarkMode") private var isDarkMode = true
    @AppStorage("isLeftSidebarExpanded") private var isLeftSidebarExpanded = true
    @AppStorage("isRightSidebarExpanded") private var isRightSidebarExpanded = true

    private var theme: ConductorThemePalette {
        isDarkMode ? ConductorThemes.dark : ConductorThemes.light
    }

    private var leftSidebarWidth: CGFloat {
        isLeftSidebarExpanded ? 280 : 0
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

                Spacer(minLength: 0)

                if isLeftSidebarExpanded {
                    SidebarFooter(isDarkMode: $isDarkMode, theme: theme)
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
            .frame(minWidth: leftSidebarWidth, idealWidth: leftSidebarWidth, maxWidth: leftSidebarWidth)
            .clipped()

            // Center (main content area)
            VStack(spacing: 0) {
                MainHeaderScaffold(theme: theme)

                // Scrollable content area
                theme.mainCanvas

                // Input bar
                VStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(theme.inputFill)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(theme.inputStroke, lineWidth: 1)
                        )
                        .frame(height: 80)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                }
                .background(theme.mainCanvas)
            }
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

private struct MainHeaderScaffold: View {
    let theme: ConductorThemePalette

    var body: some View {
        VStack(spacing: 0) {
            Color.clear
                .frame(height: 44)
                .background(.ultraThinMaterial)
                .background(
                    LinearGradient(
                        colors: [theme.headerTopStart, theme.headerTopEnd],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(theme.headerDivider)
                        .frame(height: 1)
                }

            Color.clear
                .frame(height: 46)
                .background(.ultraThinMaterial)
                .background(
                    LinearGradient(
                        colors: [theme.headerTabsStart, theme.headerTabsEnd],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(theme.headerBottomDivider)
                        .frame(height: theme.headerBottomDividerThickness)
                }
                .overlay(alignment: .bottomLeading) {
                    Rectangle()
                        .fill(theme.headerActiveLine)
                        .frame(width: 140, height: 2)
                        .padding(.leading, 34)
                }
        }
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
                guard let window = NSApplication.shared.keyWindow else { return }
                switch action {
                case .close: window.close()
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
    let theme: ConductorThemePalette

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.footerDivider)
                .frame(height: 1)

            HStack(spacing: 14) {
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
}

#Preview {
    ContentView()
        .frame(width: 1200, height: 750)
        .preferredColorScheme(.dark)
}
