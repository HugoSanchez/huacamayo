enum SidecarManagedSessionAction: Equatable {
    case clearLocal
    case start
    case synchronize
    case restart
}

struct SidecarManagedSessionPolicy {
    static func action(
        isSidecarRunning: Bool,
        previousUserId: String?,
        nextUserId: String?
    ) -> SidecarManagedSessionAction {
        if isSidecarRunning {
            return requiresRestart(previousUserId: previousUserId, nextUserId: nextUserId)
                ? .restart
                : .synchronize
        }
        return nextUserId == nil ? .clearLocal : .start
    }

    static func requiresRestart(previousUserId: String?, nextUserId: String?) -> Bool {
        previousUserId != nextUserId
    }
}
