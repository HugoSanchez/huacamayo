import SwiftUI

private enum ConductorTheme {
    static let sidebarTop = Color(red: 38/255, green: 47/255, blue: 45/255)      // #262F2D
    static let sidebarBottom = Color(red: 34/255, green: 47/255, blue: 55/255)   // #222F37
    static let mainCanvas = Color(red: 20/255, green: 22/255, blue: 24/255)      // #141618
    static let inputFill = Color(red: 30/255, green: 32/255, blue: 34/255)       // #1E2022
    static let rightTop = Color(red: 19/255, green: 21/255, blue: 23/255)        // #131517
    static let rightBottom = Color(red: 19/255, green: 21/255, blue: 23/255)     // #131517
    static let verticalDivider = Color(red: 42/255, green: 45/255, blue: 48/255) // #2A2D30
    static let horizontalDivider = Color(red: 42/255, green: 45/255, blue: 48/255) // #2A2D30
    static let windowBorder = Color.white.opacity(0.08)
    static let windowCornerRadius: CGFloat = 10
}

struct ContentView: View {
    var body: some View {
        HSplitView {
            // Left sidebar
            VStack(spacing: 0) {
                // Window controls
                HStack(spacing: 8) {
                    WindowControlButton(color: Color(red: 1.0, green: 0.38, blue: 0.35), action: .close)
                    WindowControlButton(color: Color(red: 1.0, green: 0.78, blue: 0.24), action: .miniaturize)
                    WindowControlButton(color: Color(red: 0.30, green: 0.85, blue: 0.39), action: .zoom)
                    Spacer()
                }
                .padding(.leading, 14)
                .padding(.top, 14)
                .padding(.bottom, 10)

                Spacer(minLength: 0)

                SidebarFooter()
            }
            .background(
                LinearGradient(
                    colors: [ConductorTheme.sidebarTop, ConductorTheme.sidebarBottom],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(ConductorTheme.verticalDivider)
                    .frame(width: 1)
            }
            .frame(minWidth: 220, idealWidth: 280, maxWidth: 360)

            // Center (main content area)
            VStack(spacing: 0) {
                // Scrollable content area
                ConductorTheme.mainCanvas

                // Input bar
                VStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(ConductorTheme.inputFill)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
                        )
                        .frame(height: 80)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                }
                .background(ConductorTheme.mainCanvas)
            }
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(ConductorTheme.verticalDivider)
                    .frame(width: 1)
            }
            .frame(minWidth: 400, idealWidth: 600)

            // Right panel (vertical split)
            VSplitView {
                // Top: file tree area
                ConductorTheme.rightTop
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(ConductorTheme.horizontalDivider)
                            .frame(height: 1)
                    }
                    .frame(minHeight: 120)

                // Bottom: tabbed area
                ConductorTheme.rightBottom
                    .frame(minHeight: 120)
            }
            .frame(minWidth: 300, idealWidth: 380, maxWidth: 500)
        }
        .ignoresSafeArea()
        .background(ConductorTheme.mainCanvas)
        .clipShape(RoundedRectangle(cornerRadius: ConductorTheme.windowCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ConductorTheme.windowCornerRadius, style: .continuous)
                .strokeBorder(ConductorTheme.windowBorder, lineWidth: 1)
        }
    }
}

// MARK: - Window Control Button

enum WindowAction {
    case close, miniaturize, zoom
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
    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color.white.opacity(0.10))
                .frame(height: 1)

            HStack(spacing: 14) {
                Spacer()

                Button(action: {}) {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(Color.white.opacity(0.52))
                }
                .buttonStyle(.plain)

                Button(action: {}) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(Color.white.opacity(0.52))
                }
                .buttonStyle(.plain)
            }
            .padding(.trailing, 16)
            .padding(.vertical, 10)
            .background(Color.black.opacity(0.06))
        }
    }
}

#Preview {
    ContentView()
        .frame(width: 1200, height: 750)
        .preferredColorScheme(.dark)
}
