const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const CLIENT_ID = "<CLIENT_ID>";

function getPlaylistNameFromUrl(url) {
    try {
        let u = new URL(url);
        let parts = u.pathname.split('/').filter(Boolean);
        return parts[parts.length - 1];
    } catch (e) {
        return 'playlist';
    }
}

async function getTrackInfo(trackUrl) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const url = `${trackUrl}?client_id=${CLIENT_ID}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    resolve(info);
                } catch (e) {
                    console.error("Failed to parse track JSON:", e);
                    reject(e);
                }
            });
        }).on('error', (err) => {
            console.error("Error fetching track info from SoundCloud API:", err);
            reject(err);
        });
    });
}

// Helper to remove all characters from a string that are not valid Windows filename characters
function sanitizeWindowsFileName(name) {
    let sanitized = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
    sanitized = sanitized.replace(/[. ]+$/, '');
    return sanitized;
}

async function constructFileName(trackInfo){
    let artist, title;
    const hasArtist = trackInfo.publisher_metadata?.artist !== null && trackInfo.publisher_metadata?.artist !== undefined;
    if(hasArtist){
        artist = trackInfo.publisher_metadata.artist;
        title = trackInfo.title;
    } else {
        artist = trackInfo.user?.username;
        title = trackInfo.title;
    }
    artist = sanitizeWindowsFileName(artist || '');
    title = sanitizeWindowsFileName(title || '');
    let fileName = `${artist} - ${title}.wav`;
    fileName = sanitizeWindowsFileName(fileName);
    if (!fileName || fileName === '.wav') {
        fileName = 'track.wav';
    }
    return fileName;
}

function getPlaylistEntries(playlistUrl) {
    return new Promise((resolve, reject) => {
        exec(`yt-dlp --flat-playlist -J "${playlistUrl}"`, (err, stdout, stderr) => {
            if (err) {
                try {
                    console.error("Error fetching playlist info:", stderr ? stderr.toString() : err.toString());
                } catch (e) {
                    console.error("Error fetching playlist info and decoding stderr failed.");
                }
                process.exit(1);
            }
            try {
                const info = JSON.parse(stdout);
                const entries = info.entries || [];
                resolve(entries);
            } catch (e) {
                console.error("Failed to decode playlist info JSON:", e);
                process.exit(1);
            }
        });
    });
}

function getTrackDisplayName(entry) {
    if (entry && entry.title) return entry.title;
    if (entry && entry.id) return `https://api-v2.soundcloud.com/tracks/${entry.id}`;
    if (entry && entry.url) return entry.url;
    return 'Unknown Track';
}

function getArtistAndTitle(trackInfo) {
    const hasArtist = trackInfo.publisher_metadata?.artist !== null && trackInfo.publisher_metadata?.artist !== undefined;
    if (hasArtist) {
        return `${trackInfo.publisher_metadata.artist} - ${trackInfo.title}`;
    } else if (trackInfo && trackInfo.user?.username) {
        return `${trackInfo.user.username} - ${trackInfo.title}`;
    }
    return trackInfo && trackInfo.title ? trackInfo.title : 'Unknown Track';
}

function getYearFromTrackInfo(trackInfo) {
    // Try to extract year from release_date or created_at
    let dateStr = trackInfo && (trackInfo.release_date || trackInfo.created_at);
    if (!dateStr) return '';
    // Accepts formats like "2022-01-01T00:00:00Z" or "2022-01-01"
    const match = dateStr.match(/^(\d{4})/);
    return match ? match[1] : '';
}

// Progress bar construction function
function buildProgressBar({ percent, idx, total, artistTitle = '', prefix = '', suffix = '' }) {
    const barLength = 30;
    const filledLength = Math.round(barLength * percent);
    const bar = '█'.repeat(filledLength) + '-'.repeat(barLength - filledLength);
    const percentStr = `${Math.round(percent * 100)}%`;
    let display = `[${bar}] ${idx}/${total} (${percentStr})`;
    if (artistTitle) display += ` ${artistTitle}`;
    if (prefix) display = prefix + display;
    if (suffix) display += suffix;
    return display;
}

// Use a global counter for progress bar order
let globalDownloadCounter = 0;

// Modified downloadTrack to use getTrackInfo and constructFileName
// Now: download as mp3, but do not set tags
async function downloadTrack(trackUrl, outputDir, entry, total) {
    let trackInfo;
    try {
        trackInfo = await getTrackInfo(trackUrl);
    } catch (e) {
        console.error(`Failed to fetch track info for: ${trackUrl}`);
        return false;
    }
    let fileName;
    try {
        fileName = await constructFileName(trackInfo);
    } catch (e) {
        console.error(`Failed to construct file name for: ${trackUrl}`);
        return false;
    }
    const outputPath = path.join(outputDir, fileName);

    // Try different audio formats if WAV fails
    const audioFormats = ['wav', 'mp3', 'm4a'];
    
    for (const format of audioFormats) {
        const formatOutputPath = outputPath.replace('.wav', `.${format}`);
        const cmd = `yt-dlp --extract-audio --audio-format ${format} --audio-quality 0 --no-progress --no-warnings -o "${formatOutputPath}" "${trackUrl}"`;
        
        const success = await new Promise((resolve) => {
            exec(cmd, async (err, stdout, stderr) => {
                if (err) {
                    // Check if this is the last format to try
                    if (format === audioFormats[audioFormats.length - 1]) {
                        console.error(`Failed to download: ${trackUrl}`);
                        if (stderr) {
                            console.error(`Reason: ${stderr}`);
                        } else if (err.message) {
                            console.error(`Error message: ${err.message}`);
                        } else {
                            console.error('No error output from yt-dlp.');
                        }
                        resolve(false);
                    } else {
                        // Try next format
                        resolve(null);
                    }
                } else {
                    // Success - rename file to .wav if it's not already
                    if (format !== 'wav') {
                        try {
                            fs.renameSync(formatOutputPath, outputPath);
                        } catch (renameErr) {
                            console.error(`Failed to rename ${formatOutputPath} to ${outputPath}:`, renameErr);
                        }
                    }
                    resolve(true);
                }
            });
        });
        
        if (success === true) {
            // Download succeeded, skip mp3 tag editing
            globalDownloadCounter++;
            const idx = globalDownloadCounter;
            const percent = total === 0 ? 1 : idx / total;
            const artistTitle = getArtistAndTitle(trackInfo);
            const progressBar = buildProgressBar({
                percent,
                idx,
                total,
                artistTitle: `Downloaded: ${artistTitle}`
            });
            process.stdout.write(progressBar + '\n');
            return true;
        } else if (success === false) {
            return false;
        }
        // else, try next format
    }
    return false;
}

async function downloadTracksInParallel(trackEntries, outputDir, maxParallel = Math.max(2, os.cpus().length)) {
    let failedIndexes = [];
    let inProgress = 0;
    let nextIndex = 0;
    let finished = 0;
    const total = trackEntries.length;

    // Reset global counter before starting
    globalDownloadCounter = 0;

    return new Promise((resolve) => {
        function startNext() {
            if (nextIndex >= total) {
                if (finished === total && inProgress === 0) {
                    // Print final progress bar
                    const percent = 1;
                    let artistTitle = '';
                    const lastEntry = trackEntries[total - 1];
                    const hasArtist = lastEntry.publisher_metadata?.artist !== null && lastEntry.publisher_metadata?.artist !== undefined;
                    if (hasArtist) {
                        artistTitle = ` | ${lastEntry.publisher_metadata.artist} - ${lastEntry.title}`;
                    } else if (lastEntry && lastEntry.user?.username) {
                        artistTitle = ` | ${lastEntry.user.username} - ${lastEntry.title}`;
                    }
                    const progressBar = buildProgressBar({
                        percent,
                        idx: total,
                        total,
                        artistTitle
                    });
                    process.stdout.write(progressBar + '\n');
                    resolve(failedIndexes);
                }
                return;
            }
            const idx = nextIndex++;
            inProgress++;
            const entry = trackEntries[idx];
            const url = entry.id ? `https://api-v2.soundcloud.com/tracks/${entry.id}` : null;
            if (!url) {
                console.log("Skipping entry with no id:", entry);
                inProgress--;
                finished++;
                startNext();
                return;
            }
            downloadTrack(url, outputDir, entry, total).then(success => {
                if (!success) {
                    failedIndexes.push(idx);
                }
                inProgress--;
                finished++;
                if (finished > total) finished = total;
                startNext();
            });
        }
        for (let i = 0; i < Math.min(maxParallel, total); ++i) {
            startNext();
        }
    });
}

async function main() {
    if (process.argv.length < 3) {
        console.log('Usage: node test.js <soundcloud_playlist_url>');
        process.exit(1);
    }

    const playlistUrl = process.argv[2];
    const playlistName = getPlaylistNameFromUrl(playlistUrl);
    const baseOutputDir = '<OUTPUT_DIR>';
    const outputDir = path.join(baseOutputDir, playlistName);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log('Fetching playlist entries...');
    let entries;
    try {
        entries = await getPlaylistEntries(playlistUrl);
    } catch (e) {
        process.exit(1);
    }

    if (!entries || entries.length === 0) {
        console.log('No tracks found in playlist.');
        process.exit(1);
    }

    const trackEntries = [];
    for (const entry of entries) {
        if (entry.id) {
            trackEntries.push({ ...entry, url: `https://api-v2.soundcloud.com/tracks/${entry.id}` });
        } else {
            console.log("Skipping entry with no id:", entry);
        }
    }

    const seenIds = new Set();
    const uniqueTrackEntries = [];
    for (const entry of trackEntries) {
        if (!seenIds.has(entry.id)) {
            uniqueTrackEntries.push(entry);
            seenIds.add(entry.id);
        }
    }

    if (uniqueTrackEntries.length !== trackEntries.length) {
        console.log(`Note: Removed ${trackEntries.length - uniqueTrackEntries.length} duplicate track(s) from playlist.`);
    }

    console.log(`Found ${uniqueTrackEntries.length} unique tracks. Starting parallel downloads...`);
    const maxParallel = Math.max(2, Math.min(8, os.cpus().length));

    const failedIndexes = await downloadTracksInParallel(uniqueTrackEntries, outputDir, maxParallel);

    if (failedIndexes.length > 0) {
        console.log(`There ${failedIndexes.length === 1 ? 'was' : 'were'} ${failedIndexes.length} track${failedIndexes.length === 1 ? '' : 's'} that failed to download:`);
        failedIndexes.forEach(idx => {
            const entry = uniqueTrackEntries[idx];
            const displayName = getTrackDisplayName(entry);
            const url = entry.id ? `https://api-v2.soundcloud.com/tracks/${entry.id}` : '';
            console.log(`  ${displayName} (${url})`);
        });
        console.log('Check the error messages above for the reason each track failed.');
    } else {
        console.log('All tracks downloaded successfully.');
    }

    console.log(`All tracks downloaded to '${outputDir}' as .wav files.`);
}

main();
