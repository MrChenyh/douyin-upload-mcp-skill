from conf import LOCAL_CHROME_PATH


async def launch_chromium(playwright, headless=True):
    if LOCAL_CHROME_PATH:
        return await playwright.chromium.launch(
            headless=headless,
            executable_path=LOCAL_CHROME_PATH,
        )
    return await playwright.chromium.launch(headless=headless, channel="chrome")
