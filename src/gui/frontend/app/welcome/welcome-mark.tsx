import { motion, useTransform, type MotionValue } from "motion/react";

/** 欢迎页标识仅淡入，不播放循环装饰动画。 */
export function WelcomeMark({ time }: { time: MotionValue<number> }) {
	const opacity = useTransform(time, [0, 0.5], [0, 1]);
	return <motion.div className="pimoon-mark" style={{ opacity }} aria-hidden="true">
		<img src="./welcome-moon.svg" width="160" height="160" alt="" />
		<div className="pimoon-horizon" />
	</motion.div>;
}
