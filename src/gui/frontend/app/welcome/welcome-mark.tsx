import { motion, useTransform, type MotionValue } from "motion/react";

/** 月相标识替代旧插画；仅入场，不在后台持续运行动画。 */
export function WelcomeMark({ time }: { time: MotionValue<number> }) {
	const opacity = useTransform(time, [0, 0.5], [0, 1]);
	return <motion.div className="pimoon-mark" style={{ opacity }} aria-hidden="true">
		<div className="pimoon-orbit" />
		<img src="./logo.svg" width="88" height="88" alt="" />
		<span className="pimoon-star pimoon-star-one" />
		<span className="pimoon-star pimoon-star-two" />
	</motion.div>;
}
