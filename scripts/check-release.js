import { releaseFiles, scanRelease } from './release-files.js';

try {
  const files = releaseFiles(process.cwd());
  const findings = scanRelease(process.cwd(), files);
  if (findings.length) {
    // Report the file and category, never the value that matched.
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else console.log(`Release check passed for ${files.length} files. No private values or credential patterns found.`);
} catch {
  console.error('Release check failed. Check release-files.json and remove missing files, symlinks, or forbidden paths.');
  process.exitCode = 1;
}
