// Grays out a control the static demo can't run, keeping it visible so the
// demo still shows the feature exists. Outside the demo it renders the child
// untouched.
//
//   <DemoDisabled feature="jobs"><button onClick={run}>Run OCR</button></DemoDisabled>
//
// Bootstrap gives disabled buttons pointer-events:none, so the tooltip sits on
// a wrapper span, which also takes over the child's layout style.

import { cloneElement } from 'react';
import { useViewerConfig } from './state/ViewerContext.jsx';
import { isDemoDisabled } from './state/selectors.js';

export default function DemoDisabled({ feature, children }) {
  const config = useViewerConfig();
  if (!isDemoDisabled(config, feature)) return children;
  const { className = '', style } = children.props;
  return (
    <span className="d-inline-block" style={style} title="Not available in the demo" tabIndex={0}>
      {cloneElement(children, {
        className: className + ' disabled',
        style: undefined,
        disabled: true,
        'aria-disabled': true,
        href: undefined,
        onClick: undefined,
      })}
    </span>
  );
}
