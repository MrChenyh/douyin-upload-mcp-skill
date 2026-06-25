# -*- coding: utf-8 -*-
from datetime import datetime

import asyncio
import inspect
import os
import time
from pathlib import Path

from patchright.async_api import Page
from patchright.async_api import Playwright
from patchright.async_api import async_playwright

from conf import DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from utils.base_social_media import set_init_script
from utils.browser_launch import launch_chromium
from utils.login_qrcode import build_login_qrcode_path
from utils.login_qrcode import decode_qrcode_from_path
from utils.login_qrcode import print_terminal_qrcode
from utils.login_qrcode import remove_qrcode_file
from utils.login_qrcode import save_data_url_image
from utils.log import douyin_logger

DOUYIN_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
DOUYIN_PUBLISH_STRATEGY_SCHEDULED = "scheduled"
DOUYIN_FINAL_SUBMIT_TIMEOUT_SECONDS = 180


def _msg(emoji: str, text: str) -> str:
    return f"{emoji} {text}"


def _clean_text(value: str | None) -> str:
    return " ".join(str(value or "").split())


async def _emit_qrcode_callback(qrcode_callback, payload: dict):
    if not qrcode_callback:
        return

    callback_result = qrcode_callback(payload)
    if inspect.isawaitable(callback_result):
        await callback_result


def _build_login_result(success: bool, status: str, message: str, account_file: str, qrcode: dict | None = None, current_url: str = "") -> dict:
    return {
        "success": success,
        "status": status,
        "message": message,
        "account_file": str(account_file),
        "qrcode": qrcode,
        "current_url": current_url,
    }


async def cookie_auth(account_file):
    async with async_playwright() as playwright:
        browser = await launch_chromium(playwright, headless=True)
        try:
            context = await browser.new_context(storage_state=account_file)
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto("https://creator.douyin.com/creator-micro/content/upload")
            try:
                await page.wait_for_url("https://creator.douyin.com/creator-micro/content/upload", timeout=5000)
            except Exception:
                return False

            if await page.get_by_text("手机号登录").count() or await page.get_by_text("扫码登录").count():
                return False

            return True
        finally:
            await browser.close()


async def douyin_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        douyin_logger.info(_msg("🥹", "cookie 失效了，准备打开浏览器重新登录"))
        result = await douyin_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def _extract_douyin_qrcode_src(page: Page) -> str:
    scan_login_tab = page.get_by_text("扫码登录", exact=True).first
    await scan_login_tab.wait_for(timeout=30000)

    qrcode_img = (
        scan_login_tab
        .locator("..")
        .locator("xpath=following-sibling::div[1]")
        .locator('img[aria-label="二维码"]')
        .first
    )

    if not await qrcode_img.count():
        qrcode_img = page.get_by_role("img", name="二维码").first

    await qrcode_img.wait_for(state="visible", timeout=30000)
    src = await qrcode_img.get_attribute("src")
    if not src:
        raise RuntimeError("未获取到抖音登录二维码地址")

    return src


async def _save_douyin_qrcode(page: Page, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict:
    qrcode_src = await _extract_douyin_qrcode_src(page)
    qrcode_path = save_data_url_image(qrcode_src, build_login_qrcode_path(account_file))
    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if remove_qrcode_file(previous_qrcode_path):
            douyin_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))
    douyin_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = decode_qrcode_from_path(qrcode_path)
    if qrcode_content:
        print_terminal_qrcode(qrcode_content, qrcode_path, "抖音APP")
    else:
        douyin_logger.warning(_msg("😵", f"终端没法完整显示二维码，请打开 {qrcode_path} 扫码"))
    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src,
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _is_douyin_login_completed(page: Page) -> bool:
    if not page.url.startswith("https://creator.douyin.com/creator-micro/home"):
        return False

    login_markers = [
        page.get_by_text("扫码登录", exact=True).first,
        page.get_by_text("手机号登录", exact=True).first,
        page.get_by_text("二维码失效", exact=True).first,
        page.get_by_role("img", name="二维码").first,
    ]

    for marker in login_markers:
        if not await marker.count():
            continue
        try:
            if await marker.is_visible():
                return False
        except Exception:
            continue

    return True


async def _wait_for_douyin_login(page: Page, account_file: str, qrcode_info: dict, qrcode_callback=None, poll_interval: int = 3, max_checks: int = 100) -> dict:
    qrcode_path = Path(qrcode_info["image_path"])
    for _ in range(max_checks):
        if await _is_douyin_login_completed(page):
            douyin_logger.info(_msg("🥳", f"扫码成功，已经跳转到登录后页面: {page.url}"))
            return _build_login_result(True, "success", "抖音扫码登录成功", account_file, qrcode_info, page.url)

        expired_box = page.get_by_text("二维码失效", exact=True).locator("..").first
        if await expired_box.count() and await expired_box.is_visible():
            douyin_logger.warning(_msg("😵", "二维码失效了，小人马上去刷新"))
            await expired_box.click()
            await asyncio.sleep(1)
            qrcode_info = await _save_douyin_qrcode(page, account_file, qrcode_path, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])

        await asyncio.sleep(poll_interval)

    return _build_login_result(False, "timeout", "等待抖音扫码登录超时", account_file, qrcode_info, page.url)


async def douyin_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 3,
    max_checks: int = 100,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    async with async_playwright() as playwright:
        browser = await launch_chromium(playwright, headless=headless)
        context = await browser.new_context()
        context = await set_init_script(context)
        qrcode_path = None
        result = _build_login_result(False, "failed", "抖音登录失败", account_file)
        try:
            page = await context.new_page()
            await page.goto("https://creator.douyin.com/")
            qrcode_info = await _save_douyin_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            douyin_logger.info(_msg("🧍", "请扫码，小人正在耐心等待登录完成"))
            result = await _wait_for_douyin_login(
                page,
                account_file,
                qrcode_info,
                qrcode_callback=qrcode_callback,
                poll_interval=poll_interval,
                max_checks=max_checks,
            )
            if result["success"]:
                await asyncio.sleep(2)
                await context.storage_state(path=account_file)
                if not await cookie_auth(account_file):
                    result = _build_login_result(
                        False,
                        "cookie_invalid",
                        "抖音扫码流程结束，但 cookie 校验失败",
                        account_file,
                        qrcode_info,
                        page.url,
                    )
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
        finally:
            if remove_qrcode_file(qrcode_path):
                douyin_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                douyin_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            await context.close()
            await browser.close()
        return result


class DouYinBaseUploader(BaseVideoUploader):
    def __init__(
        self,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.publish_date = publish_date
        self.account_file = account_file
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.date_format = "%Y年%m月%d日 %H:%M"
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = headless

    async def validate_base_args(self):
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"cookie文件不存在，请先完成抖音登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"cookie文件已失效，请先完成抖音登录: {self.account_file}")
        if self.publish_strategy not in {DOUYIN_PUBLISH_STRATEGY_IMMEDIATE, DOUYIN_PUBLISH_STRATEGY_SCHEDULED}:
            raise ValueError(f"不支持的发布策略: {self.publish_strategy}")

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def set_schedule_time_douyin(self, page, publish_date):
        label_element = page.locator("[class^='radio']:has-text('定时发布')")
        await label_element.click()
        await asyncio.sleep(1)
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")

        await asyncio.sleep(1)
        await page.locator('.semi-input[placeholder="日期和时间"]').click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(str(publish_date_hour))
        await page.keyboard.press("Enter")
        await asyncio.sleep(1)

    async def fill_title_and_description(self, page: Page, title: str, description: str, tags: list[str] | None = None):
        description_section = (
            page.get_by_text("作品描述", exact=True)
            .locator("xpath=ancestor::div[2]")
            .locator("xpath=following-sibling::div[1]")
        )

        title_input = description_section.locator('input[type="text"]').first
        await title_input.wait_for(state="visible", timeout=10000)
        await title_input.fill(title[:30])

        description_editor = description_section.locator('.zone-container[contenteditable="true"]').first
        await description_editor.wait_for(state="visible", timeout=10000)
        await description_editor.click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.press("Delete")
        await page.keyboard.type(description)

        for tag in tags or []:
            await page.keyboard.type(" #" + tag)
            await page.keyboard.press("Space")

    async def set_location(self, page: Page, location: str = ""):
        if not location:
            return
        await page.locator('div.semi-select span:has-text("输入地理位置")').click()
        await page.keyboard.press("Backspace")
        await page.wait_for_timeout(2000)
        await page.keyboard.type(location)
        await page.wait_for_selector('div[role="listbox"] [role="option"]', timeout=5000)
        await page.locator('div[role="listbox"] [role="option"]').first.click()

    async def handle_product_dialog(self, page: Page, product_title: str):
        await page.wait_for_timeout(2000)
        await page.wait_for_selector('input[placeholder="请输入商品短标题"]', timeout=10000)
        short_title_input = page.locator('input[placeholder="请输入商品短标题"]')
        if not await short_title_input.count():
            douyin_logger.error(_msg("😵", "没找到商品短标题输入框"))
            return False

        product_title = product_title[:10]
        await short_title_input.fill(product_title)
        await page.wait_for_timeout(1000)

        finish_button = page.locator('button:has-text("完成编辑")')
        if "disabled" not in await finish_button.get_attribute("class"):
            await finish_button.click()
            douyin_logger.debug(_msg("🥳", "已点击“完成编辑”按钮"))
            await page.wait_for_selector(".semi-modal-content", state="hidden", timeout=5000)
            return True

        douyin_logger.error(_msg("😵", "“完成编辑”按钮是灰的，小人先把弹窗关掉"))
        cancel_button = page.locator('button:has-text("取消")')
        if await cancel_button.count():
            await cancel_button.click()
        else:
            close_button = page.locator(".semi-modal-close")
            await close_button.click()
        await page.wait_for_selector(".semi-modal-content", state="hidden", timeout=5000)
        return False

    async def set_product_link(self, page: Page, product_link: str, product_title: str):
        await page.wait_for_timeout(2000)
        try:
            await page.wait_for_selector("text=添加标签", timeout=10000)
            dropdown = page.get_by_text("添加标签").locator("..").locator("..").locator("..").locator(".semi-select").first
            if not await dropdown.count():
                douyin_logger.error(_msg("😵", "没找到标签下拉框"))
                return False
            douyin_logger.debug(_msg("🧍", "找到标签下拉框，小人准备选择“购物车”"))
            await dropdown.click()
            await page.wait_for_selector('[role="listbox"]', timeout=5000)
            await page.locator('[role="option"]:has-text("购物车")').click()
            douyin_logger.debug(_msg("🥳", "已经选中“购物车”"))

            await page.wait_for_selector('input[placeholder="粘贴商品链接"]', timeout=5000)
            input_field = page.locator('input[placeholder="粘贴商品链接"]')
            await input_field.fill(product_link)
            douyin_logger.debug(_msg("🔗", f"商品链接已经填好了: {product_link}"))

            add_button = page.locator('span:has-text("添加链接")')
            button_class = await add_button.get_attribute("class")
            if "disable" in button_class:
                douyin_logger.error(_msg("😵", "“添加链接”按钮现在点不了"))
                return False
            await add_button.click()
            douyin_logger.debug(_msg("🥳", "已点击“添加链接”按钮"))

            await page.wait_for_timeout(2000)
            error_modal = page.locator("text=未搜索到对应商品")
            if await error_modal.count():
                confirm_button = page.locator('button:has-text("确定")')
                await confirm_button.click()
                douyin_logger.error(_msg("😢", "这个商品链接无效"))
                return False

            if not await self.handle_product_dialog(page, product_title):
                return False

            douyin_logger.debug(_msg("🥳", "商品链接设置好了"))
            return True
        except Exception as e:
            douyin_logger.error(_msg("😢", f"设置商品链接时出错: {str(e)}"))
            return False


class DouYinVideo(DouYinBaseUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        thumbnail_landscape_path=None,
        productLink="",
        productTitle="",
        thumbnail_portrait_path=None,
        desc: str | None = None,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.title = title
        self.file_path = file_path
        self.tags = tags
        self.thumbnail_landscape_path = thumbnail_landscape_path
        self.thumbnail_portrait_path = thumbnail_portrait_path
        self.productLink = productLink
        self.productTitle = productTitle
        self.desc = desc or ""

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("视频模式下，title 是必须的")

        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_landscape_path:
            self.thumbnail_landscape_path = str(self.validate_image_file(self.thumbnail_landscape_path))
        if self.thumbnail_portrait_path:
            self.thumbnail_portrait_path = str(self.validate_image_file(self.thumbnail_portrait_path))

    async def handle_upload_error(self, page):
        douyin_logger.warning(_msg("😵", "视频上传摔了一跤，小人马上重新上传"))
        await page.locator('div.progress-div [class^="upload-btn-input"]').set_input_files(self.file_path)

    async def handle_auto_video_cover(self, page):
        if await page.get_by_text("请设置封面后再发布").first.is_visible():
            douyin_logger.info(_msg("🧍", "发布前还得先把封面弄好"))
            recommend_cover = page.locator('[class^="recommendCover-"]').first
            if await recommend_cover.count():
                douyin_logger.info(_msg("🏃", "小人去选第一个推荐封面"))
                try:
                    await recommend_cover.click()
                    await asyncio.sleep(1)
                    confirm_text = "是否确认应用此封面？"
                    if await page.get_by_text(confirm_text).first.is_visible():
                        douyin_logger.info(_msg("🪟", f"弹出确认框了: {confirm_text}"))
                        await page.get_by_role("button", name="确定").click()
                        douyin_logger.info(_msg("🥳", "推荐封面已经应用"))
                        await asyncio.sleep(1)
                    douyin_logger.info(_msg("🥳", "封面选择流程完成"))
                    return True
                except Exception as e:
                    douyin_logger.warning(_msg("😵", f"推荐封面没选成功: {e}"))
        return False

    async def click_publish_button(self, page: Page) -> bool:
        candidates = [
            page.get_by_role("button", name="发布", exact=True),
            page.get_by_role("button", name="发布视频", exact=True),
            page.locator("button:has-text('发布')").last,
            page.locator("[role='button']:has-text('发布')").last,
        ]
        last_error = None
        for button in candidates:
            try:
                if not await button.count():
                    continue
                target = button.first
                if not await target.is_visible():
                    continue
                disabled = await target.get_attribute("disabled")
                class_name = await target.get_attribute("class") or ""
                aria_disabled = await target.get_attribute("aria-disabled")
                if disabled is not None or aria_disabled == "true" or "disabled" in class_name:
                    continue
                await target.click(timeout=5000)
                return True
            except Exception as exc:
                last_error = exc
        if last_error:
            douyin_logger.debug(_msg("🧍", f"发布按钮暂时点不了: {last_error}"))
        return False

    async def detect_publish_blocker(self, page: Page) -> str:
        markers = [
            "验证码",
            "验证",
            "安全",
            "风控",
            "系统繁忙",
            "发布失败",
            "上传失败",
            "请设置封面后再发布",
            "请完成",
            "请填写",
            "请稍后",
        ]
        try:
            text = _clean_text(await page.locator("body").inner_text(timeout=3000))
        except Exception:
            return ""
        for marker in markers:
            if marker in text:
                start = max(0, text.find(marker) - 80)
                return text[start:start + 220]
        return ""

    async def wait_for_publish_result(self, page: Page) -> None:
        start_time = time.monotonic()
        last_blocker = ""
        while True:
            current_url = page.url
            if "/creator-micro/content/manage" in current_url:
                douyin_logger.success(_msg("🥳", "视频发布成功，小人开心收工"))
                return

            clicked = await self.click_publish_button(page)
            if clicked:
                douyin_logger.info(_msg("🚀", "已点击发布按钮，等待平台返回结果"))

            try:
                await page.wait_for_url(
                    "**/creator-micro/content/manage**",
                    timeout=5000,
                )
                douyin_logger.success(_msg("🥳", "视频发布成功，小人开心收工"))
                return
            except Exception:
                pass

            await self.handle_auto_video_cover(page)
            blocker = await self.detect_publish_blocker(page)
            if blocker and blocker != last_blocker:
                douyin_logger.warning(_msg("🧾", f"发布页提示: {blocker}"))
                last_blocker = blocker

            elapsed = time.monotonic() - start_time
            if elapsed > DOUYIN_FINAL_SUBMIT_TIMEOUT_SECONDS:
                raise RuntimeError(
                    f"抖音发布提交超时，已等待 {DOUYIN_FINAL_SUBMIT_TIMEOUT_SECONDS} 秒；"
                    f"当前页面: {page.url}；页面提示: {last_blocker or '未识别到明确提示'}"
                )

            douyin_logger.info(_msg("🏃", "小人正在冲刺发布视频"))
            if self.debug:
                await page.screenshot(full_page=True)
            await asyncio.sleep(2)

    async def set_thumbnail(self, page: Page):
        if not self.thumbnail_landscape_path and not self.thumbnail_portrait_path:
            return

        douyin_logger.info(_msg("🏃", "小人正在设置视频封面"))
        await self.click_choose_cover_entry(page)
        cover_locator_str = 'div[id*="creator-content-modal"]'
        cover_locator = page.locator(cover_locator_str)
        await page.wait_for_selector(cover_locator_str)

        upload_input = cover_locator.locator("div[class^='semi-upload upload'] >> input.semi-upload-hidden-input")

        if self.thumbnail_landscape_path:
            await page.wait_for_timeout(1000)
            await upload_input.set_input_files(self.thumbnail_landscape_path)
            await page.wait_for_timeout(3000)
            douyin_logger.info(_msg("🖼️", "横版封面上传完成"))

        if self.thumbnail_portrait_path:
            await cover_locator.locator("div[class*='steps'] div").nth(1).click()
            await page.wait_for_timeout(1000)
            await upload_input.set_input_files(self.thumbnail_portrait_path)
            await page.wait_for_timeout(3000)
            douyin_logger.info(_msg("🖼️", "竖版封面上传完成"))

        await self.click_cover_finish_button(page, cover_locator)
        await self.confirm_cover_apply_dialog(page)
        douyin_logger.info(_msg("🥳", "视频封面设置完成"))
        try:
            await cover_locator.wait_for(state="detached", timeout=10000)
        except Exception:
            await page.wait_for_selector("div.extractFooter", state="detached", timeout=10000)

    async def click_choose_cover_entry(self, page: Page):
        candidates = [
            page.locator('button:has-text("选择封面")'),
            page.locator('[role="button"]:has-text("选择封面")'),
            page.locator('div[class*="cover"]:has-text("选择封面")'),
            page.locator('div[class*="Cover"]:has-text("选择封面")'),
            page.get_by_text("选择封面", exact=True).locator("xpath=ancestor-or-self::*[self::button or @role='button' or contains(@class, 'cover') or contains(@class, 'Cover')][1]"),
            page.get_by_role("button", name="选择封面", exact=True),
            page.locator('text="选择封面"'),
        ]
        last_error = None
        for locator in candidates:
            count = await locator.count()
            for index in range(count):
                item = locator.nth(index)
                try:
                    await item.scroll_into_view_if_needed(timeout=5000)
                    await item.click(timeout=5000)
                    if await self.wait_cover_modal_opened(page, timeout=2000):
                        return
                except Exception as exc:
                    last_error = exc
                    try:
                        await item.click(timeout=5000, force=True)
                        if await self.wait_cover_modal_opened(page, timeout=2000):
                            return
                    except Exception as force_exc:
                        last_error = force_exc

        for index in range(10):
            target = await page.evaluate(
                """(index) => {
                    const visible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                    };
                    const score = (el) => {
                        const rect = el.getBoundingClientRect();
                        const name = `${el.tagName} ${el.className || ''} ${el.getAttribute('role') || ''}`;
                        let value = 0;
                        if (/button/i.test(name)) value -= 80;
                        if (/cover/i.test(name)) value -= 60;
                        if (/title/i.test(name)) value -= 20;
                        if (rect.width > 50 && rect.width < 500 && rect.height > 20 && rect.height < 220) value -= 10;
                        value += Math.abs((rect.width * rect.height) - 18000) / 10000;
                        return value;
                    };
                    const exactText = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '选择封面';
                    const seeds = [...document.querySelectorAll('button, [role="button"], div, span')]
                        .filter(visible)
                        .filter(exactText);
                    const candidates = [];
                    for (const seed of seeds) {
                        let el = seed;
                        for (let depth = 0; el && depth < 7; depth += 1, el = el.parentElement) {
                            if (!visible(el)) continue;
                            const text = (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
                            if (!text.includes('选择封面')) continue;
                            const rect = el.getBoundingClientRect();
                            if (rect.width > window.innerWidth * 0.9 || rect.height > window.innerHeight * 0.7) continue;
                            candidates.push(el);
                        }
                    }
                    const unique = [...new Set(candidates)].sort((a, b) => score(a) - score(b));
                    const el = unique[index];
                    if (!el) return { found: false, count: unique.length };
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                    try { el.click(); } catch {}
                    const rect = el.getBoundingClientRect();
                    return {
                        found: true,
                        count: unique.length,
                        index,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                        text: (el.innerText || el.textContent || '').trim(),
                        className: String(el.className || ''),
                    };
                }""",
                index,
            )
            if not target.get("found"):
                break
            if await self.wait_cover_modal_opened(page, timeout=1800):
                return
            await page.mouse.click(target["x"], target["y"])
            if await self.wait_cover_modal_opened(page, timeout=1800):
                return

        raise RuntimeError(f"没有找到可点击的选择封面入口: {last_error}")

    async def wait_cover_modal_opened(self, page: Page, timeout: int = 30000) -> bool:
        try:
            await page.wait_for_selector(
                'div[id*="creator-content-modal"], .semi-modal:has-text("设置封面"), .semi-modal-wrap:has-text("设置封面")',
                timeout=timeout,
            )
            return True
        except Exception:
            return False

    async def click_cover_finish_button(self, page: Page, cover_locator):
        button_names = ["完成", "完成编辑", "保存", "确定", "确认"]
        for name in button_names:
            locators = [
                cover_locator.get_by_role("button", name=name, exact=True),
                page.get_by_role("button", name=name, exact=True),
                cover_locator.locator(f'button:visible:has-text("{name}")'),
                page.locator(f'button:visible:has-text("{name}")'),
            ]
            for locator in locators:
                count = await locator.count()
                for index in range(count - 1, -1, -1):
                    button = locator.nth(index)
                    if await self.is_clickable_cover_button(button):
                        await page.wait_for_timeout(1000)
                        await button.scroll_into_view_if_needed()
                        await button.click()
                        douyin_logger.info(_msg("🥳", f"已点击封面弹窗按钮: {name}"))
                        return

        target = await page.evaluate(
            """() => {
                const visible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const modal = [...document.querySelectorAll('.semi-modal, .semi-modal-wrap, [role="dialog"], div[id*="creator-content-modal"]')]
                    .find((el) => visible(el) && /封面|保存|完成/.test(el.innerText || ''));
                const root = modal || document;
                const candidates = [...root.querySelectorAll('button, [role="button"], div, span')]
                    .filter(visible)
                    .filter((el) => /^(完成|完成编辑|保存|确定|确认)$/.test((el.innerText || el.textContent || '').replace(/\\s+/g, '').trim()))
                    .filter((el) => {
                        const className = String(el.className || '');
                        return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(className);
                    })
                    .sort((a, b) => {
                        const ar = a.getBoundingClientRect();
                        const br = b.getBoundingClientRect();
                        const ap = /primary/.test(String(a.className || '')) ? 0 : 1;
                        const bp = /primary/.test(String(b.className || '')) ? 0 : 1;
                        if (ap !== bp) return ap - bp;
                        return (ar.width * ar.height) - (br.width * br.height);
                    });
                const button = candidates[0];
                if (!button) return { found: false };
                const rect = button.getBoundingClientRect();
                return {
                    found: true,
                    text: (button.innerText || button.textContent || '').trim(),
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            }"""
        )
        if target.get("found"):
            await page.wait_for_timeout(1000)
            await page.mouse.click(target["x"], target["y"])
            douyin_logger.info(_msg("🥳", f"已点击封面弹窗坐标按钮: {target.get('text')}"))
            return

        await self.log_cover_modal_diagnostics(page, cover_locator, "finish_button_not_found")
        raise RuntimeError("封面上传完成后没有找到可点击的完成/保存按钮")

    async def confirm_cover_apply_dialog(self, page: Page):
        target = await page.evaluate(
            """() => {
                const text = document.body?.innerText || '';
                if (!/是否确认应用此封面|确认应用|应用此封面/.test(text)) return { found: false };
                const visible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const candidates = [...document.querySelectorAll('button, [role="button"], div, span')]
                    .filter(visible)
                    .filter((el) => /^(确定|确认)$/.test((el.innerText || el.textContent || '').replace(/\\s+/g, '').trim()))
                    .filter((el) => {
                        const modalText = el.closest('.semi-modal, .semi-modal-wrap, [role="dialog"]')?.innerText || '';
                        return /是否确认应用此封面|确认应用|应用此封面/.test(modalText || text);
                    })
                    .sort((a, b) => {
                        const ap = /primary/.test(String(a.className || '')) ? 0 : 1;
                        const bp = /primary/.test(String(b.className || '')) ? 0 : 1;
                        if (ap !== bp) return ap - bp;
                        const ar = a.getBoundingClientRect();
                        const br = b.getBoundingClientRect();
                        return (ar.width * ar.height) - (br.width * br.height);
                    });
                const button = candidates[0];
                if (!button) return { found: true, ok: false, error: 'cover_apply_confirm_button_not_found' };
                const rect = button.getBoundingClientRect();
                return { found: true, ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }"""
        )
        if not target.get("found"):
            return
        if not target.get("ok"):
            raise RuntimeError(target.get("error") or "cover_apply_confirm_failed")
        await page.wait_for_timeout(500)
        await page.mouse.click(target["x"], target["y"])
        try:
            await page.wait_for_function(
                """() => !/是否确认应用此封面|确认应用|应用此封面/.test(document.body?.innerText || '')""",
                timeout=10000,
            )
        except Exception:
            pass
        douyin_logger.info(_msg("🥳", "已确认应用自定义封面"))

    async def is_clickable_cover_button(self, button) -> bool:
        try:
            if not await button.is_visible():
                return False
            if not await button.is_enabled():
                return False
            class_name = await button.get_attribute("class") or ""
            aria_disabled = await button.get_attribute("aria-disabled") or ""
            disabled = await button.get_attribute("disabled")
            return disabled is None and aria_disabled.lower() != "true" and "disabled" not in class_name
        except Exception:
            return False

    async def log_cover_modal_diagnostics(self, page: Page, cover_locator, reason: str):
        try:
            buttons = await page.locator("button").evaluate_all(
                """buttons => buttons.map((button) => {
                    const rect = button.getBoundingClientRect();
                    const style = window.getComputedStyle(button);
                    return {
                        text: (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim(),
                        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                        disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
                        className: button.className ? String(button.className) : ''
                    };
                }).filter((item) => item.text).slice(-20)"""
            )
            douyin_logger.warning(_msg("🧾", f"封面弹窗按钮诊断({reason}): {buttons}"))
        except Exception as exc:
            douyin_logger.warning(_msg("🧾", f"封面弹窗按钮诊断失败({reason}): {exc}"))

        try:
            modal_text = (await cover_locator.inner_text(timeout=1000)).replace("\n", " ")[:800]
            douyin_logger.warning(_msg("🧾", f"封面弹窗文本片段({reason}): {modal_text}"))
        except Exception as exc:
            douyin_logger.warning(_msg("🧾", f"封面弹窗文本读取失败({reason}): {exc}"))

        if not self.debug:
            return

        try:
            diagnostics_dir = Path(self.account_file).parent.parent / "logs" / "diagnostics"
            diagnostics_dir.mkdir(parents=True, exist_ok=True)
            screenshot_path = diagnostics_dir / f"douyin-cover-{datetime.now().strftime('%Y%m%d-%H%M%S')}.png"
            await page.screenshot(path=str(screenshot_path), full_page=True)
            douyin_logger.warning(_msg("🧾", f"封面弹窗诊断截图: {screenshot_path}"))
        except Exception as exc:
            douyin_logger.warning(_msg("🧾", f"封面弹窗诊断截图失败({reason}): {exc}"))

    async def upload(self, playwright: Playwright) -> None:
        douyin_logger.info(_msg("🧍", "小人先检查 cookie、视频文件、封面和发布时间"))
        await self.validate_upload_args()
        douyin_logger.info(_msg("🥳", "上传前检查通过"))

        browser = await launch_chromium(playwright, headless=self.headless)
        context = await browser.new_context(
            storage_state=f"{self.account_file}",
            permissions=["geolocation"],
        )
        context = await set_init_script(context)

        page = await context.new_page()
        await page.goto("https://creator.douyin.com/creator-micro/content/upload")
        douyin_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}.mp4"))
        douyin_logger.info(_msg("🧭", "小人正在赶往上传主页"))
        await page.wait_for_url("https://creator.douyin.com/creator-micro/content/upload")
        await page.locator("div[class^='container'] input").set_input_files(self.file_path)

        while True:
            try:
                await page.wait_for_url(
                    "https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page",
                    timeout=3000,
                )
                douyin_logger.info(_msg("🥳", "已经进入 version_1 发布页面"))
                break
            except Exception:
                try:
                    await page.wait_for_url(
                        "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
                        timeout=3000,
                    )
                    douyin_logger.info(_msg("🥳", "已经进入 version_2 发布页面"))
                    break
                except Exception:
                    douyin_logger.debug(_msg("🧍", "还没进到视频发布页面，小人继续等一会"))
                    await asyncio.sleep(0.5)

        await asyncio.sleep(1)
        douyin_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_title_and_description(page, self.title, self.desc or self.title, self.tags)
        douyin_logger.info(_msg("🏷️", f"小人一共贴了 {len(self.tags)} 个话题"))

        while True:
            try:
                number = await page.locator('[class^="long-card"] div:has-text("重新上传")').count()
                if number > 0:
                    douyin_logger.success(_msg("🥳", "视频已经传完啦"))
                    break
                douyin_logger.info(_msg("🏃", "小人正在努力上传视频"))
                await asyncio.sleep(2)
                if await page.locator('div.progress-div > div:has-text("上传失败")').count():
                    douyin_logger.error(_msg("😵", "检测到上传失败，小人准备重试"))
                    await self.handle_upload_error(page)
            except Exception:
                douyin_logger.debug(_msg("🧍", "小人还在等视频上传完成"))
                await asyncio.sleep(2)

        if self.productLink and self.productTitle:
            douyin_logger.info(_msg("🛒", "小人正在设置商品链接"))
            await self.set_product_link(page, self.productLink, self.productTitle)
            douyin_logger.info(_msg("🥳", "商品链接设置完成"))

        await self.set_thumbnail(page)

        third_part_element = '[class^="info"] > [class^="first-part"] div div.semi-switch'
        if await page.locator(third_part_element).count():
            if "semi-switch-checked" not in await page.eval_on_selector(third_part_element, "div => div.className"):
                await page.locator(third_part_element).locator("input.semi-switch-native-control").click()

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_douyin(page, self.publish_date)

        await self.wait_for_publish_result(page)

        await context.storage_state(path=self.account_file)
        douyin_logger.success(_msg("🥳", "cookie 更新完毕"))
        await asyncio.sleep(2)
        await context.close()
        await browser.close()

    async def douyin_upload_video(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)

    async def main(self):
        await self.douyin_upload_video()


class DouYinNote(DouYinBaseUploader):
    def __init__(
        self,
        image_paths,
        note,
        tags,
        publish_date: datetime | int,
        account_file,
        title: str | None = None,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.image_paths = image_paths
        self.note = note or ""
        self.title = title or (self.note[:30] if self.note else "")
        self.tags = tags or []

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("图文模式下，title 是必须的")
        if not self.image_paths:
            raise ValueError("图文模式下，图片是必须的")

        if isinstance(self.image_paths, (str, Path)):
            self.image_paths = [self.image_paths]

        if len(self.image_paths) > 35:
            raise ValueError("图文模式下最多只支持上传 35 张图片")

        normalized_image_paths = []
        for image_path in self.image_paths:
            normalized_image_paths.append(str(self.validate_image_file(image_path)))
        self.image_paths = normalized_image_paths

    async def upload_note_content(self, page: Page) -> None:
        douyin_logger.info(_msg("🏃", f"小人开始搬运图文，共 {len(self.image_paths)} 张图片"))
        douyin_logger.info(_msg("🔀", "小人正在切换到图文发布"))
        await page.get_by_text("发布图文", exact=True).click()
        await page.wait_for_timeout(1000)

        douyin_logger.info(_msg("📤", "小人正在上传图片"))
        await page.locator("div[class^='container'] input[accept*='image']").set_input_files(self.image_paths)

        while True:
            try:
                await page.wait_for_url(
                    "**/creator-micro/content/post/image?**",
                    timeout=3000,
                )
                douyin_logger.info(_msg("🥳", "已经进入图文发布页面"))
                break
            except Exception:
                douyin_logger.debug(_msg("🧍", "小人还在等图片上传完成"))
                await asyncio.sleep(0.5)

        await asyncio.sleep(1)
        douyin_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_title_and_description(page, self.title, self.note, self.tags)
        douyin_logger.info(_msg("🏷️", f"小人一共贴了 {len(self.tags)} 个话题"))

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_douyin(page, self.publish_date)

        while True:
            try:
                publish_button = page.get_by_role("button", name="发布", exact=True)
                if await publish_button.count():
                    await publish_button.click()
                await page.wait_for_url(
                    "**/creator-micro/content/manage?enter_from=publish**",
                    timeout=3000,
                )
                douyin_logger.success(_msg("🥳", "图文发布成功，小人开心收工"))
                break
            except Exception:
                douyin_logger.info(_msg("🏃", "小人正在冲刺发布图文"))
                await asyncio.sleep(0.5)

    async def upload(self, playwright: Playwright) -> None:
        douyin_logger.info(_msg("🧍", "小人先检查 cookie、图片和发布时间"))
        await self.validate_upload_args()
        douyin_logger.info(_msg("🥳", "图文上传前检查通过"))

        browser = await launch_chromium(playwright, headless=self.headless)
        context = await browser.new_context(
            storage_state=f"{self.account_file}",
            permissions=["geolocation"],
        )
        context = await set_init_script(context)

        upload_success = False
        try:
            page = await context.new_page()
            await page.goto("https://creator.douyin.com/creator-micro/content/upload")
            douyin_logger.info(_msg("🧭", "小人正在赶往图文发布页"))
            await page.wait_for_url("https://creator.douyin.com/creator-micro/content/upload")

            await self.upload_note_content(page)
            upload_success = True
        finally:
            if upload_success:
                await context.storage_state(path=self.account_file)
                douyin_logger.success(_msg("🥳", "cookie 更新完毕"))
                await asyncio.sleep(2)
            await context.close()
            await browser.close()

    async def douyin_upload_note(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
