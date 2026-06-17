"""
Risk Manager — "Казначей" маркет-мейкера
=========================================

Задача: Контролировать инвентарь (баланс "Да" и "Нет") и риски.

Логика:
1. Проверять: не превысила ли позиция максимальный лимит.
2. Если позиция перекошена — рассчитать сдвиг цен (skew_offset).
3. Модифицировать размеры ордеров для балансировки.

Инвентарный сдвиг (Inventory Skew):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Механизм: Если бот накопил много YES-токенов, он "перекошен" в одну
сторону. Чтобы вернуться к балансу, бот сдвигает ОБе цены вниз:

  → Сдвиг вниз = Дешевле покупаем YES = Меньше покупателей
  → Сдвиг вниз = Дешевле продаём YES = Стимулируем продажу

И наоборот: если много NO (мало YES), сдвигаем цены ВВЕРХ,
чтобы стимулировать покупку YES.

Формула сдвига:
  skew_offset = -sign(net_position) * min(
      |net_position - threshold| * skew_per_dollar,
      max_skew
  )

Знак минус: больше YES → сдвиг вниз (отрицательный offset).
"""

import logging
from typing import Optional

from .config import BotConfig
from .models import Inventory, RiskAssessment

logger = logging.getLogger(__name__)


class RiskManager:
    """
    Менеджер рисков маркет-мейкера.

    Контролирует:
    - Максимальный размер позиции
    - Инвентарный перекос и сдвиг цен
    - Размеры ордеров для балансировки
    """

    def __init__(self, config: BotConfig) -> None:
        self._config = config

    def assess(self, inventory: Inventory) -> RiskAssessment:
        """
        Главная функция: оценить риски и дать рекомендации.

        Args:
            inventory: Текущий инвентарь бота

        Returns:
            RiskAssessment с разрешением/запретом торговли и параметрами сдвига
        """
        # ── Шаг 1: Проверка максимальной позиции ─────────────────
        max_pos = self._config.inventory.max_position_usd
        total_exposure = inventory.total_exposure_usd

        if total_exposure > max_pos:
            reason = (
                f"Превышен лимит позиции: "
                f"${total_exposure:.2f} > ${max_pos:.2f}. "
                f"Торговля остановлена."
            )
            logger.warning(reason)
            return RiskAssessment(
                allowed=False,
                reason=reason,
                position_skew_usd=inventory.net_position_usd,
                should_reduce=True,
            )

        # ── Шаг 2: Рассчитать инвентарный перекос ───────────────
        skew_offset = self._calculate_skew_offset(inventory)

        # ── Шаг 3: Рассчитать модификаторы размеров ордеров ─────
        bid_modifier, ask_modifier = self._calculate_size_modifiers(inventory)

        # ── Шаг 4: Определить, нужно ли уменьшать позицию ────────
        should_reduce = self._should_reduce_position(inventory)

        # ── Шаг 5: Сформировать результат ────────────────────────
        assessment = RiskAssessment(
            allowed=True,
            position_skew_usd=inventory.net_position_usd,
            skew_offset_cents=skew_offset,
            should_reduce=should_reduce,
            bid_size_modifier=bid_modifier,
            ask_size_modifier=ask_modifier,
        )

        self._log_assessment(inventory, assessment)
        return assessment

    def _calculate_skew_offset(self, inventory: Inventory) -> float:
        """
        Рассчитать сдвиг цены из-за инвентарного перекоса.

        Возвращает сдвиг в ЦЕНТАХ:
          - Отрицательный → сдвигаем цены ВНИЗ (много YES, хотим продать)
          - Положительный → сдвигаем цены ВВЕРХ (много NO, хотим купить YES)

        Формула:
          Если |net_position| > threshold:
              excess = |net_position| - threshold
              raw_offset = excess * skew_per_dollar
              offset = min(raw_offset, max_skew)
              skew_offset = -sign(net_position) * offset
          Иначе:
              skew_offset = 0
        """
        cfg = self._config.inventory
        net_pos = inventory.net_position_usd
        abs_net = abs(net_pos)

        # Если перекос ниже порога — не сдвигаем
        if abs_net <= cfg.skew_threshold_usd:
            return 0.0

        # Размер превышения порога
        excess = abs_net - cfg.skew_threshold_usd

        # Сырой сдвиг = превышение * коэффициент
        raw_offset = excess * cfg.skew_per_dollar_cents

        # Ограничиваем максимальным сдвигом
        clamped_offset = min(raw_offset, cfg.max_skew_cents)

        # Знак: много YES (net_pos > 0) → сдвигаем ВНИЗ (отрицательный offset)
        #       много NO  (net_pos < 0) → сдвигаем ВВЕРХ (положительный offset)
        sign = 1.0 if net_pos > 0 else -1.0
        skew_offset = -sign * clamped_offset

        return round(skew_offset, 2)

    def _calculate_size_modifiers(
        self, inventory: Inventory
    ) -> tuple[float, float]:
        """
        Рассчитать модификаторы размеров ордеров.

        Логика:
        - Если много YES → уменьшаем размер bid (не покупаем ещё больше YES),
                           увеличиваем ask (активнее продаём YES).
        - Если много NO  → уменьшаем ask (не продаём ещё больше YES),
                           увеличиваем bid (активнее покупаем YES).

        Модификатор: 0.0 = не размещать ордер, 1.0 = полный размер.

        Returns:
            (bid_modifier, ask_modifier)
        """
        cfg = self._config.inventory
        net_pos = inventory.net_position_usd
        abs_net = abs(net_pos)
        max_pos = cfg.max_position_usd

        # Доля заполненности позиции (0.0 — пусто, 1.0 — максимум)
        fill_ratio = min(abs_net / max_pos, 1.0) if max_pos > 0 else 0.0

        bid_modifier = 1.0
        ask_modifier = 1.0

        if inventory.is_long_yes:
            # Много YES: уменьшаем покупку (bid), увеличиваем продажу (ask)
            # Чем больше заполнена позиция, тем меньше покупаем
            bid_modifier = max(0.0, 1.0 - fill_ratio)
            # Продажу немного усиливаем
            ask_modifier = min(1.5, 1.0 + fill_ratio * 0.5)

        elif inventory.is_long_no:
            # Много NO: уменьшаем продажу (ask), увеличиваем покупку (bid)
            ask_modifier = max(0.0, 1.0 - fill_ratio)
            bid_modifier = min(1.5, 1.0 + fill_ratio * 0.5)

        return round(bid_modifier, 2), round(ask_modifier, 2)

    def _should_reduce_position(self, inventory: Inventory) -> bool:
        """
        Определить, нужно ли активно уменьшать позицию.

        Позиция считается "крупной" и требующей сокращения,
        если она превышает 80% от максимального лимита.
        """
        cfg = self._config.inventory
        threshold = cfg.max_position_usd * 0.8
        return inventory.total_exposure_usd > threshold

    @staticmethod
    def _log_assessment(
        inventory: Inventory, assessment: RiskAssessment
    ) -> None:
        """Логировать результаты оценки рисков."""
        logger.info(
            "Risk Assessment: "
            "allowed=%s, "
            "net_pos=$%.2f, "
            "exposure=$%.2f, "
            "skew_offset=%.2fc, "
            "bid_mod=%.2f, "
            "ask_mod=%.2f, "
            "should_reduce=%s",
            assessment.allowed,
            inventory.net_position_usd,
            inventory.total_exposure_usd,
            assessment.skew_offset_cents,
            assessment.bid_size_modifier,
            assessment.ask_size_modifier,
            assessment.should_reduce,
        )
