#!/usr/bin/env python3
"""
ocr_image.py
用 PaddleOCR 识别题目截图，提取文字，输出 JSON 到 stdout。
被 parse_input.js 通过子进程调用，不需要任何 API Key。

用法：
    python ocr_image.py <图片路径>
    python ocr_image.py --base64 <base64字符串>

输出（stdout）：
    {"success": true,  "text": "识别出的完整文字", "lines": ["行1", "行2", ...]}
    {"success": false, "error": "错误原因"}

依赖安装：
    # CPU 版（推荐，无需 GPU）
    pip install paddlepaddle paddleocr

    # 如果在国内网络，用镜像加速：
    pip install paddlepaddle -i https://pypi.tuna.tsinghua.edu.cn/simple
    pip install paddleocr   -i https://pypi.tuna.tsinghua.edu.cn/simple
"""

import sys
import json
import os
import base64
import tempfile
import re

def load_image_from_path(img_path):
    if not os.path.exists(img_path):
        return None, f"文件不存在: {img_path}"
    return img_path, None

def load_image_from_base64(b64_str):
    """把 base64 字符串写成临时文件，返回路径。"""
    try:
        data = base64.b64decode(b64_str)
        suffix = ".jpg"
        # 检测文件头以判断格式
        if data[:8] == b'\x89PNG\r\n\x1a\n':
            suffix = ".png"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(data)
        tmp.close()
        return tmp.name, None
    except Exception as e:
        return None, f"base64 解码失败: {e}"

def run_ocr(img_path):
    """调用 PaddleOCR，返回 (lines, full_text, error)。"""
    try:
        # 国内网络模型下载提速：把下载源从 HuggingFace 切换到百度对象存储（BOS）。
        # 如果你在国内，取消下面这行的注释，首次运行时模型下载会快很多。
        # os.environ['PADDLE_PDX_MODEL_SOURCE'] = 'BOS'

        # 延迟导入，让错误信息更友好（必须在设置环境变量之后再 import）
        from paddleocr import PaddleOCR

        # use_angle_cls=True 能处理旋转文字（手机拍照常见）
        # lang='ch' 支持中英文混合（行测题目标准场景）
        # show_log=False 关掉冗长的 PaddlePaddle 日志
        ocr = PaddleOCR(use_angle_cls=True, lang='ch', show_log=False)

        # PaddleOCR v3.x 用 predict()，v2.x 用 ocr()
        # 这里做兼容处理
        if hasattr(ocr, 'predict'):
            # v3.x API
            results = ocr.predict(img_path)
            lines = []
            for res in results:
                # v3 结果结构：res 是 dict，有 'rec_texts' 和 'rec_scores'
                texts  = res.get('rec_texts',  [])
                scores = res.get('rec_scores', [])
                for text, score in zip(texts, scores):
                    if score > 0.5 and text.strip():
                        lines.append(text.strip())
        else:
            # v2.x API
            results = ocr.ocr(img_path, cls=True)
            lines = []
            if results and results[0]:
                for item in results[0]:
                    text, score = item[1][0], item[1][1]
                    if score > 0.5 and text.strip():
                        lines.append(text.strip())

        if not lines:
            return [], "", "未识别到文字，请检查图片是否清晰"

        full_text = "\n".join(lines)
        return lines, full_text, None

    except ImportError:
        return [], "", (
            "PaddleOCR 未安装。请运行：\n"
            "pip install paddlepaddle paddleocr\n"
            "国内镜像：pip install paddlepaddle paddleocr "
            "-i https://pypi.tuna.tsinghua.edu.cn/simple"
        )
    except Exception as e:
        return [], "", f"OCR 识别出错: {e}"

def guess_module(text):
    """从识别文字中猜测科目，辅助后续解析。"""
    patterns = {
        "判断推理": ["判断推理", "逻辑判断", "图形推理", "定义判断", "类比推理"],
        "数量关系": ["数量关系", "数学运算", "数字推理"],
        "言语理解": ["言语理解", "语言表达", "阅读理解"],
        "资料分析": ["资料分析", "图表分析"],
        "申论":     ["申论", "大作文", "归纳概括", "综合分析"],
    }
    for module, keywords in patterns.items():
        for kw in keywords:
            if kw in text:
                return module
    return None

def main():
    args = sys.argv[1:]

    if not args:
        print(json.dumps({"success": False, "error": "用法: ocr_image.py <路径> 或 --base64 <字符串>"}, ensure_ascii=False))
        sys.exit(1)

    # 解析参数
    if args[0] == "--base64":
        if len(args) < 2:
            print(json.dumps({"success": False, "error": "--base64 后需要跟 base64 字符串"}, ensure_ascii=False))
            sys.exit(1)
        img_path, err = load_image_from_base64(args[1])
        is_temp = True
    else:
        img_path, err = load_image_from_path(args[0])
        is_temp = False

    if err:
        print(json.dumps({"success": False, "error": err}, ensure_ascii=False))
        sys.exit(1)

    # 跑 OCR
    lines, full_text, ocr_err = run_ocr(img_path)

    # 清理临时文件
    if is_temp and img_path and os.path.exists(img_path):
        os.unlink(img_path)

    if ocr_err:
        print(json.dumps({"success": False, "error": ocr_err}, ensure_ascii=False))
        sys.exit(1)

    result = {
        "success":       True,
        "text":          full_text,
        "lines":         lines,
        "line_count":    len(lines),
        "guessed_module": guess_module(full_text),  # 可选：辅助 JS 侧解析
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
