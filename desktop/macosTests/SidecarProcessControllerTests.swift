import Foundation
import XCTest

@MainActor
final class SidecarProcessControllerTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("verso-process-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    func testLaunchResolvesReadyPortAndStopsCleanly() async throws {
        let controller = makeController()
        let port = try await controller.launch(
            configuration: shellConfiguration(
                #"printf '{\"status\":\"ready\",\"port\":43127}\n'; sleep 30"#
            ),
            onUnexpectedExit: { reason in
                XCTFail("Unexpected exit callback during explicit stop: \(reason)")
            }
        )

        XCTAssertEqual(port, 43_127)
        XCTAssertTrue(controller.isRunning)
        let stopped = await controller.stopGracefully()
        XCTAssertTrue(stopped)
        XCTAssertFalse(controller.isRunning)
    }

    func testStructuredStartupFailureIsSurfaced() async throws {
        let controller = makeController()

        do {
            _ = try await controller.launch(
                configuration: shellConfiguration(
                    #"printf '{\"status\":\"error\",\"code\":\"port_in_use\",\"message\":\"Address unavailable\",\"recoverable\":true}\n' >&2; exit 1"#
                ),
                onUnexpectedExit: { _ in }
            )
            XCTFail("Expected launch to fail")
        } catch {
            XCTAssertEqual(
                error.localizedDescription,
                "Sidecar startup failed (port_in_use): Address unavailable"
            )
        }
        XCTAssertFalse(controller.isRunning)
    }

    func testUnexpectedExitAfterReadinessIsReported() async throws {
        let controller = makeController()
        let exited = expectation(description: "unexpected exit callback")
        var exitReason: String?

        _ = try await controller.launch(
            configuration: shellConfiguration(
                #"printf '{\"status\":\"ready\",\"port\":43128}\n'; sleep 0.2; exit 7"#
            ),
            onUnexpectedExit: { reason in
                exitReason = reason
                exited.fulfill()
            }
        )

        await fulfillment(of: [exited], timeout: 2)
        XCTAssertEqual(exitReason, "exit code=7")
        XCTAssertFalse(controller.isRunning)
    }

    func testStoppingDuringStartupUnblocksPendingLaunch() async {
        let controller = makeController()
        let launch = Task {
            try await controller.launch(
                configuration: shellConfiguration("sleep 30"),
                onUnexpectedExit: { _ in }
            )
        }
        try? await Task.sleep(for: .milliseconds(100))

        controller.stopImmediately()

        do {
            _ = try await launch.value
            XCTFail("Expected pending launch to fail after stop")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Sidecar exited before becoming ready")
        }
    }

    private func makeController() -> SidecarProcessController {
        SidecarProcessController(logFileURL: temporaryDirectory.appendingPathComponent("sidecar.log"))
    }

    private func shellConfiguration(_ command: String) -> SidecarProcessConfiguration {
        SidecarProcessConfiguration(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", command],
            currentDirectoryURL: temporaryDirectory,
            environment: ProcessInfo.processInfo.environment
        )
    }
}
