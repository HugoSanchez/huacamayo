import SwiftUI

/// Source list displayed in the left sidebar.
struct SourceListView: View {
    @ObservedObject var sourceManager: SourceManager
    let iconColor: Color
    let dividerColor: Color
    let isDarkMode: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Section header
            HStack {
                Text("SOURCES")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(iconColor.opacity(0.6))
                    .tracking(0.8)

                Spacer()

                Button(action: { sourceManager.addFolder() }) {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(iconColor)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            if sourceManager.sources.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(sourceManager.sources) { source in
                            SourceRow(
                                source: source,
                                isScanning: sourceManager.scanningSourceId == source.id,
                                iconColor: iconColor,
                                isDarkMode: isDarkMode,
                                onDelete: {
                                    Task { await sourceManager.removeSource(id: source.id) }
                                }
                            )
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 24))
                .foregroundStyle(iconColor.opacity(0.3))
            Text("Add a folder to get started")
                .font(.system(size: 12))
                .foregroundStyle(iconColor.opacity(0.4))
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

private struct SourceRow: View {
    let source: SourceManager.Source
    let isScanning: Bool
    let iconColor: Color
    let isDarkMode: Bool
    let onDelete: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder.fill")
                .font(.system(size: 13))
                .foregroundStyle(iconColor.opacity(0.5))

            VStack(alignment: .leading, spacing: 2) {
                Text(source.name)
                    .font(.system(size: 13))
                    .foregroundStyle(iconColor.opacity(0.85))
                    .lineLimit(1)

                HStack(spacing: 4) {
                    if isScanning {
                        ProgressView()
                            .controlSize(.mini)
                        Text("Scanning...")
                            .font(.system(size: 10))
                            .foregroundStyle(iconColor.opacity(0.4))
                    } else {
                        Text(statusText)
                            .font(.system(size: 10))
                            .foregroundStyle(iconColor.opacity(0.4))
                    }
                }
            }

            Spacer()

            if isHovered {
                Button(action: onDelete) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(iconColor.opacity(0.4))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isHovered ? (isDarkMode ? Color.white.opacity(0.06) : Color.black.opacity(0.04)) : .clear)
        )
        .onHover { isHovered = $0 }
    }

    private var statusText: String {
        if source.fileCount > 0 {
            return "\(source.fileCount) file\(source.fileCount == 1 ? "" : "s")"
        }
        return source.status
    }
}
