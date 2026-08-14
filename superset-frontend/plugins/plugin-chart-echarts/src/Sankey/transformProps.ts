/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { ComposeOption } from 'echarts/core';
import type { SankeySeriesOption } from 'echarts/charts';
import type { CallbackDataParams } from 'echarts/types/src/util/types';
import {
  CategoricalColorNamespace,
  NumberFormats,
  getColumnLabel,
  getMetricLabel,
  getNumberFormatter,
  tooltipHtml,
} from '@superset-ui/core';
import { SankeyChartProps, SankeyTransformedProps } from './types';
import { Refs } from '../types';
import { getDefaultTooltip } from '../utils/tooltip';
import { getPercentFormatter } from '../utils/formatters';

type Link = { source: string; target: string; value: number };
type EChartsOption = ComposeOption<SankeySeriesOption>;

export default function transformProps(
  chartProps: SankeyChartProps,
): SankeyTransformedProps {
  const refs: Refs = {};
  const { formData, height, hooks, queriesData, width, theme } = chartProps;
  const { onLegendStateChanged } = hooks;
  const { colorScheme, metric, source, target, sliceId } = formData;
  const { data } = queriesData[0];
  const colorFn = CategoricalColorNamespace.getScale(colorScheme);
  const metricLabel = getMetricLabel(metric);
  const valueFormatter = getNumberFormatter(NumberFormats.FLOAT_2_POINT);
  const percentFormatter = getPercentFormatter(NumberFormats.PERCENT_2_POINT);

  const links: Link[] = [];
  const set = new Set<string>();
  data.forEach(datum => {
    const sourceName = String(datum[getColumnLabel(source)]);
    const targetName = String(datum[getColumnLabel(target)]);
    const value = datum[metricLabel] as number;
    set.add(sourceName);
    set.add(targetName);
    links.push({
      source: sourceName,
      target: targetName,
      value,
    });
  });

  /*
   * Build the Sankey node order from the hierarchy instead of allowing
   * nodes at the same depth to be globally ordered by size.
   *
   * Children remain grouped under their parent, while children within
   * each parent are ordered from largest to smallest.
   */

  const targets = new Set<string>();
  const childrenByParent = new Map<string, Set<string>>();
  const valuesByParent = new Map<string, Map<string, number>>();

  links.forEach(link => {
    const { source, target, value } = link;

    targets.add(target);

    if (!childrenByParent.has(source)) {
      childrenByParent.set(source, new Set<string>());
    }

    childrenByParent.get(source)!.add(target);

    if (!valuesByParent.has(source)) {
      valuesByParent.set(source, new Map<string, number>());
    }

    const childValues = valuesByParent.get(source)!;

    childValues.set(
      target,
      (childValues.get(target) ?? 0) + value,
    );
  });

  const getSortedChildren = (parent: string): string[] => {
    const children = childrenByParent.get(parent);

    if (!children) {
      return [];
    }

    const childValues = valuesByParent.get(parent);

    return Array.from(children).sort(
      (a, b) =>
        (childValues?.get(b) ?? 0) -
        (childValues?.get(a) ?? 0),
    );
  };

  // Root nodes are nodes which are never the target of another link.
  const roots = Array.from(set).filter(name => !targets.has(name));

  const orderedNames: string[] = [];
  const visited = new Set<string>();

  let currentLevel = roots;

  while (currentLevel.length > 0) {
    /*
     * Add all nodes at the current depth first.
     *
     * Their order was determined by their respective parents during
     * the previous iteration.
     */
    currentLevel.forEach(name => {
      if (!visited.has(name)) {
        orderedNames.push(name);
        visited.add(name);
      }
    });

    // Build the next level parent-by-parent.
    const nextLevel: string[] = [];
    const queued = new Set<string>();

    currentLevel.forEach(parent => {
      const children = getSortedChildren(parent);

      children.forEach(child => {
        if (!visited.has(child) && !queued.has(child)) {
          nextLevel.push(child);
          queued.add(child);
        }
      });
    });

    currentLevel = nextLevel;
  }

  /*
   * Safety fallback for any nodes that were not reachable from a root,
   * such as unusual graph structures.
   */
  Array.from(set).forEach(name => {
    if (!visited.has(name)) {
      orderedNames.push(name);
    }
  });

  const seriesData: NonNullable<SankeySeriesOption['data']> =
    orderedNames.map(name => ({
      name,
      itemStyle: {
        color: colorFn(name, sliceId),
      },
      label: {
        color: theme.colorText,
        textShadow: theme.colorBgBase,
      },
    }));

  // stores a map with the total values for each node considering the links
  const incomingFlows = new Map<string, number>();
  const outgoingFlows = new Map<string, number>();
  const allNodeNames = new Set<string>();

  links.forEach(link => {
    const { source, target, value } = link;
    allNodeNames.add(source);
    allNodeNames.add(target);
    incomingFlows.set(target, (incomingFlows.get(target) || 0) + value);
    outgoingFlows.set(source, (outgoingFlows.get(source) || 0) + value);
  });

  const nodeValues = new Map<string, number>();

  allNodeNames.forEach(nodeName => {
    const totalIncoming = incomingFlows.get(nodeName) || 0;
    const totalOutgoing = outgoingFlows.get(nodeName) || 0;

    nodeValues.set(nodeName, Math.max(totalIncoming, totalOutgoing));
  });

  const tooltipFormatter = (params: CallbackDataParams) => {
    const { name, data } = params;
    const value = params.value as number;
    const rows = [[metricLabel, valueFormatter.format(value)]];
    const { source, target } = data as Link;
    if (source && target) {
      rows.push([
        `% (${source})`,
        percentFormatter.format(value / nodeValues.get(source)!),
      ]);
      rows.push([
        `% (${target})`,
        percentFormatter.format(value / nodeValues.get(target)!),
      ]);
    }
    return tooltipHtml(rows, name);
  };

  const echartOptions: EChartsOption = {
    series: {
      animation: false,
      data: seriesData,
      lineStyle: {
        color: 'source',
      },
      links,
      type: 'sankey',
      nodeAlign: 'left',
      layoutIterations: 0,
    },
    tooltip: {
      ...getDefaultTooltip(refs),
      formatter: tooltipFormatter,
    },
  };

  return {
    refs,
    formData,
    width,
    height,
    echartOptions,
    onLegendStateChanged,
  };
}
