import * as chai from 'chai';
import { XmlParser } from '../../../src/components/xmlParser/xmlParser';
import { Log, LogEntry, noopLog } from '../../../src/logger';
import {
	TestablePlaylistProcessor,
	createMockSos,
	createDefaultOptions,
	createMockFiles,
	createMockTriggers,
	createMockPriority,
} from './testUtils';

const expect = chai.expect;

// The exact banner SMIL from the reported field issue: a conditional <seq repeatCount="indefinite">
// nested inside an outer <seq>, targeting a flat region.
const BANNER_SMIL = `
<smil>
<head>
<layout>
<root-layout height="1080" width="1920"/>
<region height="1080" left="0" regionName="slideshow" top="0" width="1920" z-index="1"/>
</layout>
<meta content="15" http-equiv="Refresh" onlySmilUpdate="true"/>
</head>
<body>
<par begin="__prefetchEnd.endEvent">
<seq>
<seq expr="compare(gmdate(),'2026-10-27T23:00:00') &gt;= 0 and compare(gmdate(),'2026-10-30T23:00:00') &lt; 0"
     repeatCount="indefinite">
<img dur="10s"
     expr="compare(gmdate(),'2026-10-27T23:00:00') &gt;= 0 and compare(gmdate(),'2026-10-30T23:00:00') &lt; 0"
     region="slideshow" src="https://example.com/future-post.jpg"/>
</seq>
<img dur="3s" region="slideshow" src="https://example.com/default-image.jpg"/>
</seq>
</par>
</body>
</smil>
`;

describe('SmilPlayer content-update race (regionInfo)', () => {
	it('spins forever logging "no regionInfo" when traversed before PlaylistDataPrepare has run', async () => {
		// smilPlayer.ts's main() calls `this.processor.setSmilObject(smilObject)` BEFORE
		// `this.dataPrepare.manageFilesAndInfo(smilObject, smilUrl)` has populated `regionInfo` on
		// every element. On a content update, the previous SMIL version's playback loop is still
		// running and reads `this.smilObject.playlist` fresh on every pass (handlePlaylistProcessing)
		// - it isn't cancelled until the NEW loop's first pass runs, which can't happen until
		// manageFilesAndInfo finishes. In that window it traverses a tree where no element has
		// `regionInfo` yet. This reproduces that exact "unprepared" state directly.
		const smilObject = await new XmlParser(noopLog).processSmilXml(BANNER_SMIL);
		// deliberately NOT calling PlaylistDataPrepare.manageFilesAndInfo() - this mirrors the
		// window between setSmilObject() and manageFilesAndInfo() in smilPlayer.ts.

		const WARNING_THRESHOLD = 10;
		const entries: LogEntry[] = [];
		let processor: TestablePlaylistProcessor;
		const capturingLog = new Log(
			{
				write: (entry) => {
					entries.push(entry);
					// Cancel from inside the same synchronous callstack as the warning itself: every
					// pass resolves without ever really awaiting anything, so this loop can starve
					// Node's macrotask queue outright - a timer-based cutoff (e.g. sleep()) never fires.
					const warnings = entries.filter((e) => e.level === 'warn' && e.message.includes('no regionInfo'));
					if (warnings.length >= WARNING_THRESHOLD) {
						processor.setCancelFunction(true, 0);
					}
				},
			},
			'test',
		);

		processor = new TestablePlaylistProcessor(
			createMockSos(),
			createMockFiles(),
			createDefaultOptions(),
			capturingLog,
			{ triggers: createMockTriggers(), priority: createMockPriority() },
		);
		processor.setSmilObject(smilObject);

		// Mirrors the normal playback loop: handlePlaylistProcessing calling
		// processPlaylist(this.smilObject.playlist, version) on every pass. Without the cancel
		// above, nothing in production ever stops this loop either.
		await processor.processPlaylist(smilObject.playlist, 0);

		const regionInfoWarnings = entries.filter(
			(e) => e.level === 'warn' && e.message.includes('skipping element with no regionInfo'),
		);

		expect(regionInfoWarnings.length).to.be.at.least(WARNING_THRESHOLD);
		expect(regionInfoWarnings[0].args).to.include('img0');
	});
});
