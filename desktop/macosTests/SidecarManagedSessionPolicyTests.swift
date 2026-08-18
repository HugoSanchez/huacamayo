import XCTest

final class SidecarManagedSessionPolicyTests: XCTestCase {
    func testStoppedSidecarStartsOnlyWhenSessionIsPresent() {
        XCTAssertEqual(
            SidecarManagedSessionPolicy.action(
                isSidecarRunning: false,
                previousUserId: nil,
                nextUserId: "user-1"
            ),
            .start
        )
        XCTAssertEqual(
            SidecarManagedSessionPolicy.action(
                isSidecarRunning: false,
                previousUserId: "user-1",
                nextUserId: nil
            ),
            .clearLocal
        )
    }

    func testRunningSidecarSynchronizesSameIdentity() {
        XCTAssertEqual(
            SidecarManagedSessionPolicy.action(
                isSidecarRunning: true,
                previousUserId: "user-1",
                nextUserId: "user-1"
            ),
            .synchronize
        )
    }

    func testRunningSidecarRestartsAcrossIdentityBoundary() {
        let transitions: [(String?, String?)] = [
            (nil, "user-1"),
            ("user-1", nil),
            ("user-1", "user-2"),
        ]
        for transition in transitions {
            XCTAssertEqual(
                SidecarManagedSessionPolicy.action(
                    isSidecarRunning: true,
                    previousUserId: transition.0,
                    nextUserId: transition.1
                ),
                .restart
            )
        }
    }
}
