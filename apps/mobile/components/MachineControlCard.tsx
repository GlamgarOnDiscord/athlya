import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

import {
  canStep,
  type ControlError,
  type MachineControl,
  type RunState,
} from '../features/ftms/machine-control';

import { useRuntime } from './RuntimeProvider';
import { AppText } from './ui/AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Notice } from './ui/Notice';

import type { ControlRange } from '../features/ftms/control-point';
import type { TranslationKeys } from '@athlya/shared/i18n';

const ERROR_KEYS: Readonly<Record<ControlError, TranslationKeys>> = {
  notPermitted: 'mobile.machine.control.errors.notPermitted',
  notSupported: 'mobile.machine.control.errors.notSupported',
  invalidParameter: 'mobile.machine.control.errors.invalidParameter',
  failed: 'mobile.machine.control.errors.failed',
  timeout: 'mobile.machine.control.errors.timeout',
  controlLost: 'mobile.machine.control.errors.controlLost',
};

const RUN_KEYS: Readonly<Record<RunState, TranslationKeys>> = {
  started: 'mobile.machine.control.run.started',
  paused: 'mobile.machine.control.run.paused',
  stopped: 'mobile.machine.control.run.stopped',
};

interface TargetStepperProps {
  readonly label: string;
  readonly valueText: string;
  readonly range: ControlRange;
  readonly target: number | null;
  readonly disabled: boolean;
  readonly onStep: (direction: 1 | -1) => void;
}

/**
 * One target with − and + buttons. The value row is also an `adjustable`
 * element, so screen-reader users can swipe up or down to change it.
 */
function TargetStepper({ label, valueText, range, target, disabled, onStep }: TargetStepperProps) {
  const { t } = useRuntime();
  const canDecrease = !disabled && canStep(range, target, -1);
  const canIncrease = !disabled && canStep(range, target, 1);
  return (
    <View className="gap-sm">
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'increment' && canIncrease) onStep(1);
          if (event.nativeEvent.actionName === 'decrement' && canDecrease) onStep(-1);
        }}
        className="flex-row justify-between"
      >
        <AppText variant="muted">{label}</AppText>
        <AppText>{valueText}</AppText>
      </View>
      <View className="flex-row gap-sm">
        <View className="flex-1">
          <Button
            title="−"
            accessibilityLabel={t('mobile.machine.control.decrease', { name: label })}
            variant="secondary"
            disabled={!canDecrease}
            onPress={() => {
              onStep(-1);
            }}
          />
        </View>
        <View className="flex-1">
          <Button
            title="+"
            accessibilityLabel={t('mobile.machine.control.increase', { name: label })}
            variant="secondary"
            disabled={!canIncrease}
            onPress={() => {
              onStep(1);
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Machine control (issue #668): only the targets the machine advertises
 * are shown, and every control stays disabled until the machine granted
 * control and while a command awaits its answer.
 */
export function MachineControlCard({
  control,
  measuredPowerW,
}: {
  readonly control: MachineControl;
  /** Live power, the starting point of the first target power step. */
  readonly measuredPowerW: number | null;
}) {
  const { t, locale } = useRuntime();
  const state = useSyncExternalStore(control.subscribe, control.get);
  if (state.status === 'unavailable') return null;

  const { capabilities, pending } = state;
  const granted = state.status === 'granted';
  const locked = !granted || pending !== null;
  const notSet = t('mobile.machine.control.notSet');
  const level = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  return (
    <Card>
      <Text
        accessibilityRole="header"
        className="text-base font-semibold text-foreground dark:text-dark-foreground"
      >
        {t('mobile.machine.control.title')}
      </Text>
      <AppText variant="muted">{t('mobile.machine.control.intro')}</AppText>

      {state.error === null ? null : (
        <Notice
          tone={state.error === 'controlLost' ? 'info' : 'error'}
          message={t(ERROR_KEYS[state.error])}
        />
      )}
      {state.run === null ? null : <Notice message={t(RUN_KEYS[state.run])} />}

      {granted ? (
        <AppText variant="muted">{t('mobile.machine.control.granted')}</AppText>
      ) : (
        <View className="gap-sm">
          <AppText variant="muted">{t('mobile.machine.control.locked')}</AppText>
          <Button
            title={t('mobile.machine.control.request')}
            busy={state.status === 'requesting'}
            onPress={() => {
              void control.requestControl();
            }}
          />
        </View>
      )}

      {capabilities.power === null ? null : (
        <TargetStepper
          label={t('mobile.machine.control.power')}
          valueText={
            state.targetPowerW === null
              ? notSet
              : t('mobile.machine.metrics.unit.watts', { value: state.targetPowerW })
          }
          range={capabilities.power}
          target={state.targetPowerW}
          disabled={locked}
          onStep={(direction) => {
            void control.stepPower(direction, measuredPowerW);
          }}
        />
      )}

      {capabilities.resistance === null ? null : (
        <TargetStepper
          label={t('mobile.machine.control.resistance')}
          valueText={
            state.targetResistance === null
              ? notSet
              : t('mobile.machine.control.level', {
                  value: level.format(state.targetResistance / 10),
                })
          }
          range={capabilities.resistance}
          target={state.targetResistance}
          disabled={locked}
          onStep={(direction) => {
            void control.stepResistance(direction);
          }}
        />
      )}

      {capabilities.startStop ? (
        <View className="flex-row gap-sm">
          <View className="flex-1">
            <Button
              title={t('mobile.machine.control.start')}
              variant="secondary"
              disabled={locked}
              busy={pending === 'start'}
              onPress={() => {
                void control.start();
              }}
            />
          </View>
          <View className="flex-1">
            <Button
              title={t('mobile.machine.control.pause')}
              variant="secondary"
              disabled={locked}
              busy={pending === 'pause'}
              onPress={() => {
                void control.pause();
              }}
            />
          </View>
          <View className="flex-1">
            <Button
              title={t('mobile.machine.control.stop')}
              variant="secondary"
              disabled={locked}
              busy={pending === 'stop'}
              onPress={() => {
                void control.stop();
              }}
            />
          </View>
        </View>
      ) : null}

      {granted ? (
        <Button
          title={t('mobile.machine.control.release')}
          variant="secondary"
          disabled={pending !== null}
          busy={pending === 'reset'}
          onPress={() => {
            void control.reset();
          }}
        />
      ) : null}
    </Card>
  );
}
