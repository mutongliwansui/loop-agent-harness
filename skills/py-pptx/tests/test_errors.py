"""错误码体系基线测试。"""

import pytest

from slidep import (
    ErrorCode,
    SlidepError,
    SlidepSystemError,
    SlidepUserError,
    dsl_error,
    io_error,
    layout_error,
)


class TestErrorCodeUniqueness:
    """错误码唯一性。"""

    def test_no_duplicate_values(self):
        values = [e.value for e in ErrorCode]
        assert len(values) == len(set(values)), "错误码值重复"

    def test_all_codes_have_templates(self):
        from slidep.errors import CODE_TEMPLATES

        missing = [e for e in ErrorCode if e not in CODE_TEMPLATES]
        assert not missing, f"以下错误码缺少消息模板: {missing}"

    def test_naming_prefix(self):
        for e in ErrorCode:
            assert e.value.startswith("SLIDEP_"), f"{e.value} 缺少 SLIDEP_ 前缀"


class TestErrorConstruction:
    def test_user_error_message_filled(self):
        err = dsl_error(ErrorCode.DSL_UNKNOWN_PROPERTY, prop="grid", component="Box")
        assert isinstance(err, SlidepUserError)
        assert err.code is ErrorCode.DSL_UNKNOWN_PROPERTY
        assert "grid" in str(err)
        assert err.code.value in str(err)

    def test_missing_placeholder_does_not_crash(self):
        err = dsl_error(ErrorCode.DSL_UNKNOWN_PROPERTY)  # 缺少 prop/component 占位
        assert err.code.value in str(err)  # 降级为原始字段输出

    def test_location_fields(self):
        err = layout_error(
            ErrorCode.LAYOUT_OVERFLOW,
            page="slide_01_cover",
            file="pages/slide_01_cover.py",
            lineno=12,
            node="Banner",
            exceed=40,
            canvas=720,
        )
        assert "slide_01_cover" in err.location
        assert "line=12" in err.location

    def test_to_dict_shape(self):
        err = io_error(ErrorCode.IO_FILE_NOT_FOUND, path="resources/x.png")
        d = err.to_dict()
        assert d["code"] == "SLIDEP_4001"
        assert d["location"] == "-"
        assert "message" in d and "hint" in d and "fields" in d

    def test_system_error_kind(self):
        err = SlidepSystemError(ErrorCode.CLI_EXEC_FAILED, detail="boom")
        assert isinstance(err, SlidepSystemError)
        assert isinstance(err, SlidepError)

    def test_hint_preserved(self):
        err = dsl_error(
            ErrorCode.DSL_INVALID_STYLE_VALUE,
            hint="请改用 display: flex",
            prop="display",
            value="grid",
            reason="仅支持 flex",
        )
        assert err.hint == "请改用 display: flex"


class TestErrorHierarchy:
    def test_user_error_is_not_system_error(self):
        assert not issubclass(SlidepUserError, SlidepSystemError)
        assert issubclass(SlidepUserError, SlidepError)
        assert issubclass(SlidepSystemError, SlidepError)
