import os
import time
import yt_dlp
from yt_dlp.utils import DownloadError
from helpers import setup_logger

logger = setup_logger(__name__)

INSTAGRAM_HOSTS = ("instagram.com", "www.instagram.com")

# Errors that are worth retrying (TikTok bot-detection flakes)
_RETRYABLE_FRAGMENTS = (
    "universal data for rehydration",
    "unexpected response from webpage",
    "unable to extract challenge data",
)

_TIKTOK_HOSTS = ("tiktok.com", "www.tiktok.com")


def _is_instagram_url(url: str) -> bool:
    """Return True if the URL points to Instagram."""
    try:
        from urllib.parse import urlparse
        host = urlparse(url).netloc.lower()
        return host in INSTAGRAM_HOSTS or host.endswith(".instagram.com")
    except Exception:
        return "instagram.com" in (url or "").lower()


def _is_tiktok_url(url: str) -> bool:
    """Return True if the URL points to TikTok."""
    try:
        from urllib.parse import urlparse
        host = urlparse(url).netloc.lower()
        return host in _TIKTOK_HOSTS or host.endswith(".tiktok.com")
    except Exception:
        return "tiktok.com" in (url or "").lower()


def _is_retryable(exc: Exception) -> bool:
    """Return True if a DownloadError is a transient TikTok bot-detection failure."""
    msg = str(exc).lower()
    return any(fragment in msg for fragment in _RETRYABLE_FRAGMENTS)


def format_download_error(exc: Exception, url: str) -> str:
    """Turn yt-dlp errors into actionable messages for the UI."""
    message = str(exc)
    lower = message.lower()

    if _is_instagram_url(url):
        if "empty media response" in lower or "not granting access" in lower:
            return (
                "Instagram blocked the download. Public reels need browser impersonation "
                "(curl-cffi); private or age-restricted posts also need cookies. "
                "Update to the latest Pick-a-Recipe image, then in Settings upload a "
                "cookies.txt exported while logged into instagram.com."
            )
        if "impersonation" in lower and "no impersonate target" in lower:
            return (
                "Instagram downloads require the curl-cffi dependency. "
                "Update Pick-a-Recipe or reinstall with: pip install \"yt-dlp[curl-cffi]\""
            )

    if "sign in to confirm" in lower or "not a bot" in lower:
        return (
            "YouTube blocked the download. Upload a cookies.txt file in Settings "
            "(exported while logged into YouTube)."
        )

    if "cookies" in lower and ("login" in lower or "authentication" in lower):
        return (
            "This video requires authentication. Upload a cookies.txt file in Settings "
            "for the relevant site."
        )

    return message


class VideoDownloader:
    """Downloads and extracts metadata from videos using yt-dlp.
    
    Supports multiple video sources including TikTok, YouTube, Instagram, and others
    supported by yt-dlp.
    """

    # Max attempts for transient TikTok bot-detection failures.
    _TIKTOK_MAX_RETRIES = 3
    _TIKTOK_RETRY_DELAY = 2  # seconds between attempts

    def __init__(self, url):
        self.url = url
        self.video_id = None
        logger.debug(f"VideoDownloader initialized with URL: {url}")

    def _get_cookie_options(self):
        """Get yt-dlp cookie options from configuration.
        
        Returns a dict with cookie options if configured, empty dict otherwise.
        Supports two modes:
        1. cookies_file: Path to a Netscape-format cookies.txt file
        2. cookies_browser: Browser name to extract cookies from (e.g., 'chrome', 'firefox')
        """
        from config import config
        config.reload()  # Ensure we have latest config
        
        cookie_opts = {}
        
        # Priority: cookies file > cookies from browser
        cookies_file = config.YT_DLP_COOKIES_FILE
        cookies_browser = config.YT_DLP_COOKIES_BROWSER
        
        if cookies_file and os.path.exists(cookies_file):
            cookie_opts['cookiefile'] = cookies_file
            logger.debug(f"Using cookies file: {cookies_file}")
        elif cookies_browser:
            cookie_opts['cookiesfrombrowser'] = (cookies_browser,)
            logger.debug(f"Using cookies from browser: {cookies_browser}")
        
        return cookie_opts

    def _base_ydl_opts(self):
        """Shared yt-dlp options for info extraction and download."""
        return {
            "quiet": True,
            "no_warnings": True,
            "remote_components": ["ejs:github"],
            **self._get_cookie_options(),
        }

    def _get_info(self):
        """Fetch metadata (description, title, etc.) without downloading the video.

        TikTok occasionally returns a page without the rehydration payload even
        after a successful JS-challenge solve (intermittent bot-detection flake).
        We retry up to _TIKTOK_MAX_RETRIES times for those transient errors.
        """
        logger.debug(f"Fetching video info for: {self.url}")
        ydl_opts = {
            **self._base_ydl_opts(),
            "skip_download": True,
        }

        is_tiktok = _is_tiktok_url(self.url)
        max_attempts = self._TIKTOK_MAX_RETRIES if is_tiktok else 1
        last_exc = None

        for attempt in range(1, max_attempts + 1):
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(self.url, download=False)
                self.video_id = info.get("id")
                logger.debug(f"Video ID extracted: {self.video_id}")
                return info
            except DownloadError as exc:
                last_exc = exc
                if is_tiktok and _is_retryable(exc) and attempt < max_attempts:
                    logger.warning(
                        f"TikTok bot-detection flake on attempt {attempt}/{max_attempts}, "
                        f"retrying in {self._TIKTOK_RETRY_DELAY}s…"
                    )
                    time.sleep(self._TIKTOK_RETRY_DELAY)
                    continue
                raise DownloadError(format_download_error(exc, self.url)) from exc

        # Should not be reached, but satisfy type checker
        raise DownloadError(format_download_error(last_exc, self.url)) from last_exc

    def _download_video(self):
        """Download the video to /tmp/<video_id>/ folder."""
        dish_dir = os.path.join("/tmp", self.video_id)
        video_path = os.path.join(dish_dir, f"{self.video_id}.mp4")
        os.makedirs(dish_dir, exist_ok=True)
        logger.debug(f"Downloading video to: {video_path}")
        if os.path.exists(video_path):
            logger.info("Video already downloaded.")
        else:
            logger.debug(f"Starting download from: {self.url}")
            ydl_opts = {
                **self._base_ydl_opts(),
                "outtmpl": video_path,
                # Prefer a single merged file with audio; fall back to mux or best available.
                "format": "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
                "merge_output_format": "mp4",
            }

            is_tiktok = _is_tiktok_url(self.url)
            max_attempts = self._TIKTOK_MAX_RETRIES if is_tiktok else 1
            last_exc = None

            for attempt in range(1, max_attempts + 1):
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.download([self.url])
                    break
                except DownloadError as exc:
                    last_exc = exc
                    if is_tiktok and _is_retryable(exc) and attempt < max_attempts:
                        logger.warning(
                            f"TikTok bot-detection flake on download attempt {attempt}/{max_attempts}, "
                            f"retrying in {self._TIKTOK_RETRY_DELAY}s…"
                        )
                        time.sleep(self._TIKTOK_RETRY_DELAY)
                        continue
                    raise DownloadError(format_download_error(exc, self.url)) from exc

            logger.debug(f"Download completed: {video_path}")
        return self.video_id, video_path
