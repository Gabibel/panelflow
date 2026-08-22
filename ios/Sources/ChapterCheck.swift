import BackgroundTasks
import UIKit

/// "Is there a new chapter?", asked while the app is closed.
///
/// The extension does this with `chrome.alarms`, Android with WorkManager, and
/// here it is `BGTaskScheduler`. In all three the actual work is
/// `core.checkNewChapters()` — one implementation of what counts as a new
/// chapter, what gets remembered, and what is worth waking the user for.
///
/// iOS is the strictest of the three. It grants the app a few minutes, at a
/// time it chooses based on how the user actually uses the app, and it may
/// choose never. That is not something to work around: the library is also
/// checked on every foreground, which is when a reader is going to look anyway.
@MainActor
enum ChapterCheck {

    static let identifier = "dev.panelflow.chaptercheck"

    /// Must be called before the app finishes launching, or iOS raises.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            MainActor.assumeIsolated { run(task as? BGAppRefreshTask) }
        }
    }

    /// `checkIntervalMin`, the account preference the extension builds its
    /// alarm from and Android its WorkManager period — one question, asked
    /// once, obeyed by every client.
    ///
    /// iOS treats it as the earliest acceptable time, not a schedule: the
    /// system decides the rest, and "every hour" is a floor here rather than a
    /// promise. That is still the difference between honouring the answer and
    /// discarding it.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(
            timeIntervalSinceNow: TimeInterval(Settings.checkIntervalMin * 60))
        // Submitting again replaces the pending request, so a reader who just
        // chose a shorter interval does not wait out the old one first.
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func run(_ task: BGAppRefreshTask?) {
        // Re-arm first. A run that crashes or is expired mid-check must not be
        // the last one that ever happens.
        schedule()

        let client = CheckClient { task?.setTaskCompleted(success: true) }
        // Held until the reply lands: WorkerHost only keeps its clients weakly.
        holder = client

        task?.expirationHandler = {
            MainActor.assumeIsolated {
                // Whatever finished before the cutoff still counted — the core
                // stores each entry's new chapter as it goes.
                release()
                task?.setTaskCompleted(success: true)
            }
        }

        WorkerHost.shared.start(backendURL: AppConfig.buildBackendURL)
        WorkerHost.shared.post(
            client: client,
            json: #"{"id":1,"msg":{"type":"checkNow"}}"#)
    }

    private static var holder: CheckClient?

    fileprivate static func release() { holder = nil }
}

/// File scope rather than nested in `ChapterCheck`: a type nested in another
/// type does not inherit its enclosing scope's names in Swift, so it would have
/// to reach back out by full name anyway — `release()` is that reach.
@MainActor
private final class CheckClient: PanelFlowClient {
    private var done: (() -> Void)?
    init(done: @escaping () -> Void) { self.done = done }
    func deliver(requestID: Int, bodyJSON: String) {
        let finish = done
        done = nil
        ChapterCheck.release()
        finish?()
    }
    func emit(event: String, payloadJSON: String) {}
}
