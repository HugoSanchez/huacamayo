import SwiftUI

private enum ConductorTheme {
    static let sidebarTop = Color(red: 38/255, green: 47/255, blue: 45/255)      // #262F2D
    static let sidebarBottom = Color(red: 34/255, green: 47/255, blue: 55/255)   // #222F37
    static let mainCanvas = Color(red: 20/255, green: 22/255, blue: 24/255)      // #141618
    static let inputFill = Color(red: 30/255, green: 32/255, blue: 34/255)       // #1E2022
    static let rightTop = Color(red: 19/255, green: 21/255, blue: 23/255)        // #131517
    static let rightBottom = Color(red: 19/255, green: 21/255, blue: 23/255)     // #131517
    static let verticalDivider = Color(red: 26/255, green: 28/255, blue: 30/255) // #1A1C1E
    static let horizontalDivider = Color(red: 26/255, green: 28/255, blue: 30/255) // #1A1C1E
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

                // Sidebar content area
                Color.clear
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
            .frame(minWidth: 180, idealWidth: 220, maxWidth: 300)

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
            .frame(minWidth: 240, idealWidth: 300, maxWidth: 400)
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

#Preview {
    ContentView()
        .frame(width: 1200, height: 750)
        .preferredColorScheme(.dark)
}
