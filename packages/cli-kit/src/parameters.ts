import { codecs, defineParameter, required, VALUE_SHAPE_KIND, type ParameterSet } from '@alpacakit/channels';
import { bindCliEntry, CLI_ARG_KIND, CLI_BOOLEAN_MODE, type CliOptionFlag } from '@alpacakit/channels/cli';

/** Bind Entry parameters as options, allowing array values to be supplied repeatedly. */
export function bindCliOptions(parameters: ParameterSet, flags: Readonly<Record<string, readonly CliOptionFlag[]>> = {}) {
  return bindCliEntry({
    parameters: parameters.map((parameter) => ({
      kind: CLI_ARG_KIND.option,
      parameterName: parameter.name,
      ...(flags[parameter.name] ? { flags: flags[parameter.name] } : {}),
      ...(parameter.codec.shape.kind === VALUE_SHAPE_KIND.boolean
        ? { booleanMode: CLI_BOOLEAN_MODE.flag } : {}),
      ...(parameter.codec.shape.kind === VALUE_SHAPE_KIND.array ? { repeatable: true } : {}),
    })),
  });
}

export function textParameter<const Name extends string>(name: Name, description: string) {
  return defineParameter({ name, description, codec: codecs.string(), requirement: required() });
}
