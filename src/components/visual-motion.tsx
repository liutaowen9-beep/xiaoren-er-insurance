'use client';
import {useEffect} from 'react';
import {usePathname} from 'next/navigation';
import {motion,MotionConfig,useAnimationControls,useReducedMotion} from 'motion/react';

/** Animate the surface, never key/remount business children or replay on streamed tokens. */
export function PageSurface({children,className}:{children:React.ReactNode;className?:string}){
  const path=usePathname(),controls=useAnimationControls(),reduce=useReducedMotion();
  useEffect(()=>{if(reduce){controls.set({opacity:1,y:0});return;}void controls.start({opacity:[0.96,1],y:[6,0],transition:{duration:0.22,ease:[0.22,1,0.36,1]}});return()=>controls.stop();},[path,controls,reduce]);
  return <MotionConfig reducedMotion="user"><motion.div className={className} initial={false} animate={controls}>{children}</motion.div></MotionConfig>;
}

export function ExecutionMeter({done,total,running}:{done:number;total:number;running:boolean}){
  const reduce=useReducedMotion(),ratio=total?Math.min(1,done/total):0;
  return <MotionConfig reducedMotion="user"><span className="execution-meter" aria-label={`实际完成 ${done} / ${total} 个工具`} data-running={running}>
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="meter-track" cx="22" cy="22" r="17"/><motion.circle className="meter-value" cx="22" cy="22" r="17" pathLength="1" initial={false} animate={{pathLength:ratio}} transition={{duration:reduce?0:0.22}}/></svg><span>{done}<small>/{total}</small></span>
  </span></MotionConfig>;
}
