import Foundation
import XCTest

final class SidecarStartupProtocolTests: XCTestCase {
    func testReadyEnvelopeCanSpanArbitraryChunks() {
        var parser = SidecarStartupProtocolParser()

        XCTAssertEqual(parser.append(Data(#"{"status":"rea"#.utf8)), [])
        XCTAssertEqual(
            parser.append(Data(#"dy","port":43127}"#.utf8)),
            [.ready(port: 43_127)]
        )
        XCTAssertEqual(parser.append(Data("\n".utf8)), [])
    }

    func testParserIgnoresLogsAndDecodesMultipleEnvelopes() {
        var parser = SidecarStartupProtocolParser()
        let input = """
        regular startup log
        {"status":"error","code":"port_in_use","message":"Address unavailable","recoverable":true,"details":"127.0.0.1:4242"}
        {"status":"ready","port":4243}

        """

        XCTAssertEqual(
            parser.append(Data(input.utf8)),
            [
                .failure(
                    SidecarStartupFailure(
                        code: "port_in_use",
                        message: "Address unavailable",
                        recoverable: true,
                        details: "127.0.0.1:4242"
                    )
                ),
                .ready(port: 4_243),
            ]
        )
    }

    func testParserDecodesEnvelopeWithoutTrailingNewline() {
        var parser = SidecarStartupProtocolParser()
        XCTAssertEqual(
            parser.append(Data(#"{"status":"ready","port":8080}"#.utf8)),
            [.ready(port: 8_080)]
        )
        XCTAssertEqual(parser.finish(), [])
    }

    func testLatestFailureSelectsLastStructuredStderrEnvelope() {
        let text = """
        noisy error output
        {"status":"error","message":"Earlier"}
        another diagnostic
        {"status":"error","code":"runtime_missing","message":"Hermes missing","recoverable":false}
        """

        XCTAssertEqual(
            SidecarStartupProtocolParser.latestFailure(in: text),
            SidecarStartupFailure(
                code: "runtime_missing",
                message: "Hermes missing",
                recoverable: false,
                details: nil
            )
        )
    }

    func testLargeLogChunkDoesNotDropStructuredEnvelopes() {
        var parser = SidecarStartupProtocolParser()
        let input = Data(
            (#"{"status":"ready","port":9001}"#
                + "\n"
                + String(repeating: "x", count: 80_000)).utf8
        )

        XCTAssertEqual(parser.append(input), [.ready(port: 9_001)])
        XCTAssertEqual(
            parser.append(Data(("\n" + #"{"status":"ready","port":9002}"#).utf8)),
            [.ready(port: 9_002)]
        )
    }

    func testRestartPolicyIsBoundedAndCapped() {
        let policy = SidecarRestartPolicy.standard

        XCTAssertEqual(policy.delay(forAttempt: 1), 0.4)
        XCTAssertEqual(policy.delay(forAttempt: 2), 0.8)
        XCTAssertEqual(policy.delay(forAttempt: 6), 10)
        XCTAssertEqual(policy.delay(forAttempt: 8), 10)
        XCTAssertNil(policy.delay(forAttempt: 0))
        XCTAssertNil(policy.delay(forAttempt: 9))
    }
}
